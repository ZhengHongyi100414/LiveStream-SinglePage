const NodeMediaServer = require('node-media-server');
const express = require('express');
const path = require('path');
const config = require('./config');

const app = express();
const nms = new NodeMediaServer(config);

let streamStatus = {
    live: false,
    viewers: 0,
    startedAt: null,
    bitrate: 0,
    resolution: '',
};

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
        res.json({ success: true, message: '直播已停止' });
    } else {
        res.json({ success: false, message: '直播未在进行' });
    }
});

app.get('/console', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'console.html'));
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
    streamStatus.bitrate = args.bitrate || 0;
});

nms.on('preUnPublish', (id, StreamPath, args) => {
    console.log('[NodeEvent on preUnPublish]', `id=${id} StreamPath=${StreamPath}`);
});

nms.on('postUnPublish', (id, StreamPath, args) => {
    console.log('[NodeEvent on postUnPublish]', `id=${id} StreamPath=${StreamPath}`);
    streamStatus.live = false;
    streamStatus.viewers = 0;
    streamStatus.startedAt = null;
    streamStatus.bitrate = 0;
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
    console.log('========================================');
    console.log('  OBS推流配置:');
    console.log(`    服务器: rtmp://localhost:${RTMP_PORT}/live`);
    console.log(`    密钥: ${config.stream.channelName}`);
    console.log('========================================');
});
