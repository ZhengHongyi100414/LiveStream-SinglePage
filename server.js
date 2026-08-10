const NodeMediaServer = require('node-media-server');
const express = require('express');
const path = require('path');
const fs = require('fs');
const http = require('http');
const { execFile, spawn } = require('child_process');
const config = require('./config');

const FFPROBE = '/usr/bin/ffprobe';  // 与 config.trans.ffmpeg 同目录

const app = express();
app.set('trust proxy', 1);  // Cloudflare Tunnel / Nginx 反代需要
const nms = new NodeMediaServer(config);

let streamStatus = {
    live: false,
    viewers: 0,
    startedAt: null,
    bitrate: 0,           // 兼容字段（视频码率 Kbps）
    resolution: '',       // 1280x720
    fps: 0,                // 帧率
    videoBitrate: 0,      // 视频码率 Kbps
    audioBitrate: 0,      // 音频码率 Kbps
    videoCodec: '',
    audioCodec: '',
    // 实时推送输出（HLS .ts 切片实际参数）
    outputResolution: '',
    outputFps: 0,
    outputBitrate: 0,     // .ts 切片总码率 Kbps（含音视频）
    // 当前转码模式：'copy' 直通（零重编码）| 'transcode' 重编码 | '' 空闲
    transcodeMode: '',
};

let customFfmpeg = null;  // 自定义 HLS 转码器进程

// 观众统计：记录活跃播放器 IP（HLS + FLV 统一统计）
const viewerMap = new Map();  // ip -> 最后活跃时间戳
const VIEWER_TIMEOUT = 15000;  // 15 秒无请求则判定离线

function touchViewer(req) {
    const ip = req.ip || req.socket.remoteAddress || 'unknown';
    viewerMap.set(ip, Date.now());
    streamStatus.viewers = viewerMap.size;
}

function refreshViewerCount() {
    const now = Date.now();
    for (const [ip, t] of viewerMap) {
        if (now - t > VIEWER_TIMEOUT) viewerMap.delete(ip);
    }
    streamStatus.viewers = viewerMap.size;
}
setInterval(refreshViewerCount, 5000);

// 转码设置（直播未开始时可调整）
let transcodeSettings = {
    resolution: '1080p',  // '720p' | '1080p'
    fps: 30,              // 24 | 30 | 60
    crf: 20,              // 18(高) | 20(中高) | 23(中) | 28(低)
};

let probeTimer = null;
let probeFailCount = 0;
let probeTick = 0;  // probe 轮次计数（用于降频执行输出探测）

// 用 ffprobe 探测 FLV 流，更新 streamStatus 的分辨率/帧率/码率
function probeStream() {
    const flvUrl = `http://127.0.0.1:${config.http.port}/live/${config.stream.channelName}.flv`;
    execFile(FFPROBE, [
        '-v', 'error',
        '-analyzeduration', '1500000',
        '-probesize', '1500000',
        '-show_streams',
        '-of', 'json',
        flvUrl,
    ], { timeout: 8000, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
        if (err || !stdout) {
            probeFailCount++;
            console.warn(`[probe] 失败 ${probeFailCount} 次:`, err ? err.message : '无输出');
            // 连续 2 次失败，判定流断开（postUnPublish 没触发的兜底）
            if (probeFailCount >= 2 && streamStatus.live) {
                console.warn('[probe] 连续失败，判定 OBS 已断开');
                streamStatus.live = false;
                streamStatus.viewers = 0;
                streamStatus.startedAt = null;
                stopHlsTranscoder();
                stopProbing();
            }
            return;
        }
        probeFailCount = 0;  // 成功则重置
        try {
            const data = JSON.parse(stdout);
            const v = (data.streams || []).find(s => s.codec_type === 'video');
            const a = (data.streams || []).find(s => s.codec_type === 'audio');
            if (v) {
                streamStatus.resolution = `${v.width}x${v.height}`;
                const fr = v.avg_frame_rate || v.r_frame_rate || '0/1';
                const [num, den] = fr.split('/').map(Number);
                streamStatus.fps = den ? Math.round(num / den) : 0;
                streamStatus.videoCodec = v.codec_name || '';
                const vbr = Number(v.bit_rate);
                if (!isNaN(vbr) && vbr > 0) {
                    streamStatus.videoBitrate = Math.round(vbr / 1000);
                    streamStatus.bitrate = streamStatus.videoBitrate;
                }
            }
            if (a) {
                streamStatus.audioCodec = a.codec_name || '';
                const abr = Number(a.bit_rate);
                if (!isNaN(abr) && abr > 0) {
                    streamStatus.audioBitrate = Math.round(abr / 1000);
                }
            }
            console.log(`[probe] ${streamStatus.resolution} ${streamStatus.fps}fps 视频${streamStatus.videoBitrate}kbps/${streamStatus.videoCodec} 音频${streamStatus.audioBitrate}kbps/${streamStatus.audioCodec}`);
            // 输出切片探测降频：每 3 轮（约 30s）探测一次，减少 ffprobe 进程开销
            probeTick++;
            if (probeTick % 3 === 1) probeHlsOutput();
        } catch (e) {
            console.warn('[probe] 解析失败:', e.message);
        }
    });
}

// 探测最新 HLS .ts 切片，获取实际推送给客户端的输出参数
function probeHlsOutput() {
    const hlsDir = path.join(__dirname, 'public', 'live', config.stream.channelName);
    fs.readdir(hlsDir, (err, files) => {
        if (err) return;
        const tsFiles = files.filter(f => f.endsWith('.ts')).sort();
        if (tsFiles.length === 0) return;
        const latest = tsFiles[tsFiles.length - 1];
        const tsPath = path.join(hlsDir, latest);
        execFile(FFPROBE, [
            '-v', 'error',
            '-analyzeduration', '3000000',
            '-probesize', '3000000',
            '-show_streams', '-show_format',
            '-of', 'json',
            tsPath,
        ], { timeout: 5000, maxBuffer: 1024 * 1024 }, (err2, stdout) => {
            if (err2 || !stdout) return;
            try {
                const data = JSON.parse(stdout);
                const v = (data.streams || []).find(s => s.codec_type === 'video');
                const fmt = data.format || {};
                if (v) {
                    streamStatus.outputResolution = `${v.width}x${v.height}`;
                    const fr = v.avg_frame_rate || v.r_frame_rate || '0/1';
                    const [num, den] = fr.split('/').map(Number);
                    streamStatus.outputFps = den ? Math.round(num / den) : 0;
                }
                const dur = Number(fmt.duration) || 2;
                const br = Number(fmt.bit_rate);
                if (!isNaN(br) && br > 0) {
                    streamStatus.outputBitrate = Math.round(br / 1000);
                } else if (fs.existsSync(tsPath)) {
                    const size = fs.statSync(tsPath).size;
                    streamStatus.outputBitrate = Math.round(size * 8 / dur / 1000);
                }
            } catch (e) { /* 忽略 */ }
        });
    });
}

function startProbing() {
    if (probeTimer) clearInterval(probeTimer);
    probeTick = 0;
    probeStream();
    probeTimer = setInterval(probeStream, 10000);  // 10s 一次（原 5s），降低 ffprobe 进程开销
}

function stopProbing() {
    if (probeTimer) {
        clearInterval(probeTimer);
        probeTimer = null;
    }
    probeFailCount = 0;
    streamStatus.resolution = '';
    streamStatus.fps = 0;
    streamStatus.videoBitrate = 0;
    streamStatus.audioBitrate = 0;
    streamStatus.bitrate = 0;
    streamStatus.videoCodec = '';
    streamStatus.audioCodec = '';
    streamStatus.outputResolution = '';
    streamStatus.outputFps = 0;
    streamStatus.outputBitrate = 0;
}

// 启动前清理旧 HLS 切片，避免上轮残留的 .ts/.m3u8 干扰播放
function cleanHlsDir() {
    const hlsDir = path.join(__dirname, 'public', 'live', config.stream.channelName);
    try {
        if (!fs.existsSync(hlsDir)) {
            fs.mkdirSync(hlsDir, { recursive: true });
            return;
        }
        for (const f of fs.readdirSync(hlsDir)) {
            if (f.endsWith('.ts') || f.endsWith('.m3u8')) {
                fs.unlinkSync(path.join(hlsDir, f));
            }
        }
    } catch (e) { /* 忽略 */ }
}

// 启动 HLS 分发器（根据输入流参数智能选择 直通 copy 或 重编码 transcode）
function startHlsTranscoder() {
    stopHlsTranscoder();
    cleanHlsDir();
    const hlsDir = path.join(__dirname, 'public', 'live', config.stream.channelName);
    const m3u8Path = path.join(hlsDir, 'index.m3u8');
    const rtmpInput = `rtmp://127.0.0.1:${config.rtmp.port}/live/${config.stream.channelName}`;
    const fps = transcodeSettings.fps;
    const gop = fps * 2;

    // 智能直通判定：输入已是 h264+aac、分辨率不高于目标、帧率不高于目标 → 零重编码直通
    // 输入分辨率已达标时重编码纯属浪费 CPU 且损失画质；仅当需要放大/降帧/降采样时才转码
    const targetHeight = transcodeSettings.resolution === '1080p' ? 1080 : 720;
    const inputHeight = parseInt((streamStatus.resolution || '').split('x')[1], 10) || 0;
    const canCopy = streamStatus.videoCodec === 'h264' &&
        streamStatus.audioCodec === 'aac' &&
        inputHeight > 0 && inputHeight >= targetHeight &&
        (streamStatus.fps === 0 || streamStatus.fps <= fps);

    let argv;
    if (canCopy) {
        argv = [
            '-y', '-i', rtmpInput,
            '-c', 'copy',
            '-f', 'hls',
            '-hls_time', '2',
            '-hls_list_size', '6',
            '-hls_flags', 'delete_segments+append_list+omit_endlist+independent_segments',
            m3u8Path,
        ];
        streamStatus.transcodeMode = 'copy';
        console.log(`[transcoder] 直通模式(零重编码): 输入 ${streamStatus.resolution} ${streamStatus.fps}fps ${streamStatus.videoCodec}/${streamStatus.audioCodec} → HLS`);
    } else {
        argv = [
            '-y', '-i', rtmpInput,
        ];
        // 分辨率：1080p 时加放大滤镜
        if (transcodeSettings.resolution === '1080p') {
            argv.push('-vf', 'scale=1920:1080:flags=fast_bilinear');
        }
        argv.push(
            '-c:v', 'libx264',
            '-preset', 'ultrafast',
            '-crf', String(transcodeSettings.crf),
            '-maxrate', '6000k',
            '-bufsize', '12000k',
            '-g', String(gop), '-keyint_min', String(gop), '-bf', '0', '-r', String(fps),
            '-c:a', 'copy',
            '-f', 'hls',
            '-hls_time', '2',
            '-hls_list_size', '6',
            '-hls_flags', 'delete_segments+append_list+omit_endlist+independent_segments',
            m3u8Path,
        );
        streamStatus.transcodeMode = 'transcode';
        console.log(`[transcoder] 转码模式: ${transcodeSettings.resolution} ${fps}fps CRF${transcodeSettings.crf}（输入 ${streamStatus.resolution || '未知'} ${streamStatus.fps}fps ${streamStatus.videoCodec || '未知'}/${streamStatus.audioCodec || '未知'}）`);
    }

    customFfmpeg = spawn(config.trans.ffmpeg, argv);
    customFfmpeg.stderr.on('data', (d) => { /* ffmpeg 正常输出到 stderr */ });
    customFfmpeg.on('close', (code) => {
        console.log(`[transcoder] ffmpeg 退出，code=${code}`);
        customFfmpeg = null;
    });
    customFfmpeg.on('error', (e) => {
        console.error('[transcoder] ffmpeg 启动失败:', e.message);
        customFfmpeg = null;
    });
}

function stopHlsTranscoder() {
    if (customFfmpeg) {
        try { customFfmpeg.kill('SIGKILL'); } catch (e) { /* 忽略 */ }
        customFfmpeg = null;
    }
    streamStatus.transcodeMode = '';
}

// postPublish 时：先 probe 一次拿输入参数，再根据参数智能选择直通/转码
function probeAndStartTranscoder() {
    startProbing();  // 立即执行一次 probeStream，之后每 10s 轮询
    // 等待首次 probe 完成（本地 FLV 探测通常 1-2s），再按输入参数决策启动分发器
    setTimeout(() => {
        startHlsTranscoder();
    }, 2500);
}

const validTokens = new Map();
const TOKEN_TTL = 24 * 60 * 60 * 1000;

function authenticate(req, res, next) {
    const token = req.headers['x-admin-token'];
    if (!token || !validTokens.has(token)) {
        return res.status(401).json({ success: false, message: '未授权，请先登录' });
    }
    const tokenData = validTokens.get(token);
    if (Date.now() - tokenData.createdAt > TOKEN_TTL) {
        validTokens.delete(token);
        return res.status(401).json({ success: false, message: '登录已过期，请重新登录' });
    }
    next();
}

app.use(express.json());

// FLV 代理：把 /live/*.flv 转发到 NMS 的媒体端口（统一走 3000）
app.get('/live/:channel.flv', (req, res) => {
    touchViewer(req);  // 统计 FLV 观众
    const proxyReq = http.request({
        hostname: '127.0.0.1',
        port: config.http.port,
        path: req.originalUrl,
        method: 'GET',
        headers: { ...req.headers, host: `127.0.0.1:${config.http.port}` },
    }, (proxyRes) => {
        res.writeHead(proxyRes.statusCode, proxyRes.headers);
        proxyRes.pipe(res, { end: true });
    });
    proxyReq.on('error', () => {
        if (!res.headersSent) res.status(502).end('FLV stream unavailable');
    });
    proxyReq.end();
});

// HLS 静态文件（.m3u8 / .ts 由 express.static 服务）
// 对 /live/ 路径禁用缓存 + 设置正确 MIME 类型（Cloudflare 代理需要）
app.use('/live', (req, res, next) => {
    touchViewer(req);  // 统计 HLS 观众（.m3u8 轮询 + .ts 下载都算活跃）
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    if (req.path.endsWith('.m3u8')) {
        res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
    } else if (req.path.endsWith('.ts')) {
        res.setHeader('Content-Type', 'video/mp2t');
    }
    next();
});
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/status', (req, res) => {
    // 用请求的实际 host（含 Cloudflare Tunnel 域名），不拼接本地端口
    const protocol = req.protocol;  // http 或 https
    const host = req.headers.host;   // 已含正确 host:port（或无端口）
    const baseUrl = `${protocol}://${host}`;
    const hostname = host.split(':')[0];  // RTMP 需要纯 hostname

    res.json({
        success: true,
        data: {
            ...streamStatus,
            server: {
                httpPort: config.http.port,
                apiPort: config.api.port,
                flvUrl: `${baseUrl}/live/${config.stream.channelName}.flv`,
                hlsUrl: `${baseUrl}/live/${config.stream.channelName}/index.m3u8`,
                rtmpUrl: `rtmp://${hostname}:${config.rtmp.port}/live/${config.stream.channelName}`,
                mediaUrl: baseUrl,
            },
        },
    });
});

app.post('/api/login', (req, res) => {
    const { username, password } = req.body;
    if (username === config.admin.username && password === config.admin.password) {
        const token = 'admin-token-' + Date.now();
        validTokens.set(token, { createdAt: Date.now() });
        res.json({ success: true, token: token });
    } else {
        res.status(401).json({ success: false, message: '用户名或密码错误' });
    }
});

app.post('/api/logout', authenticate, (req, res) => {
    const token = req.headers['x-admin-token'];
    validTokens.delete(token);
    res.json({ success: true, message: '已退出登录' });
});

app.post('/api/stream/start', authenticate, (req, res) => {
    if (!streamStatus.live) {
        res.json({ success: true, message: '直播就绪，请在OBS中开始推流' });
    } else {
        res.json({ success: false, message: '直播已在进行中' });
    }
});

app.post('/api/stream/stop', authenticate, (req, res) => {
    if (streamStatus.live) {
        streamStatus.live = false;
        streamStatus.viewers = 0;
        viewerMap.clear();
        streamStatus.startedAt = null;
        streamStatus.bitrate = 0;
        streamStatus.resolution = '';
        stopHlsTranscoder();
        stopProbing();
        res.json({ success: true, message: '直播已停止' });
    } else {
        res.json({ success: false, message: '直播未在进行' });
    }
});

app.get('/console', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'console.html'));
});

// 转码设置：获取
app.get('/api/transcode/settings', (req, res) => {
    res.json({ success: true, data: transcodeSettings });
});

// 转码设置：更新（仅直播未开始时可改）
app.post('/api/transcode/settings', authenticate, (req, res) => {
    if (streamStatus.live) {
        return res.json({ success: false, message: '直播进行中，无法修改转码设置' });
    }
    const { resolution, fps, crf } = req.body;
    if (resolution && ['720p', '1080p'].includes(resolution)) transcodeSettings.resolution = resolution;
    if ([24, 30, 60].includes(Number(fps))) transcodeSettings.fps = Number(fps);
    if ([18, 20, 23, 28].includes(Number(crf))) transcodeSettings.crf = Number(crf);
    res.json({ success: true, data: transcodeSettings });
});

nms.on('preConnect', (id, args) => {
    console.log('[NodeEvent on preConnect]', `id=${id}`);
});

nms.on('postConnect', (id, args) => {
    console.log('[NodeEvent on postConnect]', `id=${id}`);
});

nms.on('prePublish', (id, StreamPath, args) => {
    console.log('[NodeEvent on prePublish]', `id=${id} StreamPath=${StreamPath}`);
});

nms.on('postPublish', (id, StreamPath, args) => {
    console.log('[NodeEvent on postPublish]', `id=${id} StreamPath=${StreamPath}`);
    streamStatus.live = true;
    streamStatus.startedAt = new Date().toISOString();
    // 延迟 2 秒等 RTMP 流稳定后，探测 OBS 码率并启动自适应转码器
    setTimeout(probeAndStartTranscoder, 2000);
});

nms.on('preUnPublish', (id, StreamPath, args) => {
    console.log('[NodeEvent on preUnPublish]', `id=${id} StreamPath=${StreamPath}`);
});

nms.on('postUnPublish', (id, StreamPath, args) => {
    console.log('[NodeEvent on postUnPublish]', `id=${id} StreamPath=${StreamPath}`);
    streamStatus.live = false;
    streamStatus.viewers = 0;
    streamStatus.startedAt = null;
    stopHlsTranscoder();
    stopProbing();
});

const API_PORT = config.api.port;
const MEDIA_PORT = config.http.port;
const RTMP_PORT = config.rtmp.port;

nms.run();

app.listen(API_PORT, '0.0.0.0', () => {
    console.log('========================================');
    console.log('  单频道直播服务系统已启动');
    console.log('========================================');
    console.log(`  网页播放地址: http://localhost:${API_PORT}`);
    console.log(`  管理后台地址: http://localhost:${API_PORT}/console`);
    console.log(`  API服务端口:  ${API_PORT}`);
    console.log(`  媒体服务端口:  ${MEDIA_PORT}`);
    console.log(`  RTMP推流地址: rtmp://localhost:${RTMP_PORT}/live/${config.stream.channelName}`);
    console.log(`  FLV播放地址:  http://localhost:${MEDIA_PORT}/live/${config.stream.channelName}.flv`);
    console.log(`  HLS播放地址:  http://localhost:${MEDIA_PORT}/live/${config.stream.channelName}/index.m3u8`);
    console.log('========================================');
    console.log('  OBS推流配置:');
    console.log(`    服务器: rtmp://localhost:${RTMP_PORT}/live`);
    console.log(`    密钥: ${config.stream.channelName}`);
    console.log('========================================');
});
