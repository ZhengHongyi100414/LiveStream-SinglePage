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
        tasks: [
            {
                app: 'live',
                hls: true,
                hlsFlags: '[f=hls:hls_time=2:hls_list_size=6:hls_flags=delete_segments+append_list+omit_endlist+independent_segments]',
                vc: 'libx264',
                vcParam: ['-preset', 'veryfast', '-tune', 'zerolatency', '-g', '60', '-keyint_min', '60', '-bf', '0', '-r', '30', '-bsf:v', 'dump_extra=freq=k'],
                ac: 'copy',
            },
        ],
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
