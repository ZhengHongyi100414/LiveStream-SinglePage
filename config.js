module.exports = {
    http: {
        port: 8080,
        allow_origin: '*',
        mediaroot: './public',
    },
    rtmp: {
        port: 1935,
        chunk_size: 60000,
        gop_cache: true,
        ping: 30,
        ping_timeout: 60,
    },
    hls: {
        enabled: true,
        m3u8_cache: true,
        m3u8_maxKeep: 10,
        hls_allow_origin: '*',
    },
    trans: {
        ffmpeg: '/usr/bin/ffmpeg',
        tasks: [],
    },
    admin: {
        username: 'admin',
        password: 'admin123',
    },
    api: {
        port: 3000,
    },
    stream: {
        channelName: 'live',
    },
};
