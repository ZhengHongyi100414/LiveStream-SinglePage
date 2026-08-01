const NodeMediaServer = require('node-media-server');
const express = require('express');
const path = require('path');
const fs = require('fs');
const { execFile, spawn } = require('child_process');
const config = require('./config');

const app = express();
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
};

let customFfmpeg = null;  // 自定义 HLS 转码器进程

// 转码设置（直播未开始时可调整）
let transcodeSettings = {
    resolution: '1080p',  // '720p' | '1080p'
    fps: 30,              // 24 | 30 | 60
    crf: 20,              // 18(高) | 20(中高) | 23(中) | 28(低)
};

let probeTimer = null;
let probeFailCount = 0;

// 用 ffprobe 探测 FLV 流，更新 streamStatus 的分辨率/帧率/码率
function probeStream() {
    const flvUrl = `http://127.0.0.1:${config.http.port}/live/${config.stream.channelName}.flv`;
    execFile(config.trans.ffmpeg.replace('ffmpeg', 'ffprobe'), [
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
            probeHlsOutput();
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
        execFile(config.trans.ffmpeg.replace('ffmpeg', 'ffprobe'), [
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
    probeStream();
    probeTimer = setInterval(probeStream, 5000);
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

// 启动 HLS 转码器（根据 transcodeSettings 动态生成命令）
function startHlsTranscoder() {
    stopHlsTranscoder();
    const hlsDir = path.join(__dirname, 'public', 'live', config.stream.channelName);
    const m3u8Path = path.join(hlsDir, 'index.m3u8');
    const rtmpInput = `rtmp://127.0.0.1:${config.rtmp.port}/live/${config.stream.channelName}`;
    const fps = transcodeSettings.fps;
    const gop = fps * 2;
    const argv = [
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
    console.log(`[transcoder] 启动: ${transcodeSettings.resolution} ${fps}fps CRF${transcodeSettings.crf}`);
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
}

// postPublish 时启动 CRF 转码器 + 定时 probe（用于 console 显示输入参数）
function probeAndStartTranscoder() {
    startHlsTranscoder();
    startProbing();
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
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/status', (req, res) => {
    const mediaPort = config.http.port;
    const apiPort = config.api.port;
    const host = req.headers.host.split(':')[0] || 'localhost';

    res.json({
        success: true,
        data: {
            ...streamStatus,
            server: {
                httpPort: mediaPort,
                apiPort: apiPort,
                flvUrl: `http://${host}:${mediaPort}/live/${config.stream.channelName}.flv`,
                hlsUrl: `http://${host}:${mediaPort}/live/${config.stream.channelName}/index.m3u8`,
                rtmpUrl: `rtmp://${host}:${config.rtmp.port}/live/${config.stream.channelName}`,
                mediaUrl: `http://${host}:${mediaPort}`,
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
