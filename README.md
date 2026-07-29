# 单频道在线直播服务系统

基于 Node.js 和 Node Media Server 构建的单频道直播服务系统，支持 OBS 推流和网页端 FLV 实时播放。

## 系统架构

```
┌─────────────┐     RTMP推流      ┌─────────────────────────────────┐
│   OBS 软件   │ ─────────────────> │     Node Media Server (1935)     │
└─────────────┘                    │                                 │
                                   │  ┌─────────────────────────┐  │
┌─────────────┐  FLV拉流        ┌─> │  │  FLV 流媒体分发          │  │
│  网页播放器   │ ────────────── │   │  │  (端口 8080)             │  │
└─────────────┘                 │   │  └─────────────────────────┘  │
                                │   └─────────────────────────────────┘
┌─────────────┐  API请求       │
│  管理后台    │ ──────────────>│   ┌─────────────────────────┐
└─────────────┘                 └──>│   Express API (3000)     │
                                    │  - 状态监控              │
                                    │  - 直播控制              │
                                    │  - 静态文件服务          │
                                    └─────────────────────────┘
```

## 功能特性

- ✅ **RTMP 推流接收**：支持 OBS、FFmpeg 等 RTMP 协议推流
- ✅ **HTTP-FLV 流媒体分发**：原生 FLV 协议，低延迟直播
- ✅ **响应式播放页面**：支持桌面和移动端访问
- ✅ **管理后台**：实时监控直播状态、控制直播启停
- ✅ **多终端支持**：支持 iOS、Android、PC 主流浏览器
- ✅ **硬件解码支持**：通过 flv.js 利用浏览器硬件加速
- ✅ **API 认证保护**：管理接口需要登录认证

## 环境要求

- Node.js >= 16.0.0
- npm >= 8.x

### 系统依赖

```bash
# Ubuntu/Debian
sudo apt update

# CentOS/RHEL
sudo yum install epel-release

# macOS
brew install
```

## 快速开始

### 1. 进入项目目录

```bash
cd /your/workspace/LiveStream
```

### 2. 安装依赖

```bash
npm install
```

### 3. 配置系统

编辑 `config.js` 文件：

```javascript
module.exports = {
  http: {
    port: 8080,          // 媒体服务端口（FLV）
    allow_origin: '*',
    mediaroot: './public',
  },
  rtmp: {
    port: 1935,          // RTMP 推流端口
    chunk_size: 60000,
    gop_cache: true,
    ping: 30,
    ping_timeout: 60,
  },
  hls: {
    enabled: false,      // HLS 已禁用，使用 FLV
  },
  trans: {
    ffmpeg: '/usr/bin/ffmpeg',
    tasks: [],
  },
  admin: {
    username: 'admin',   // 管理后台用户名
    password: 'admin123', // 管理后台密码
  },
  api: {
    port: 3000,          // API 服务端口
  },
  stream: {
    channelName: 'live', // 频道名称
  },
};
```

### 4. 启动服务

```bash
npm start
```

服务启动后会显示：

```
========================================
  单频道直播服务系统已启动
========================================
  网页播放地址: http://localhost:3000
  管理后台地址: http://localhost:3000/console
  API服务端口:  3000
  媒体服务端口:  8080
  RTMP推流地址: rtmp://localhost:1935/live/live
  FLV播放地址:  http://localhost:8080/live/live.flv
========================================
```

## OBS 配置

### 推流设置

1. 打开 OBS 软件
2. 进入 **设置** → **推流**
3. 配置如下：
   - **服务**: 自定义
   - **服务器**: `rtmp://你的服务器IP:1935/live`
   - **密钥**: `live`（与 config.js 中的 channelName 一致）

### 示例

```
服务器: rtmp://192.168.1.100:1935/live
密钥: live
```

### 推荐编码设置

- **输出分辨率**: 与源一致（如 1920x1080）
- **视频比特率**: 4000-8000 Kbps
- **编码器**: x264
- **关键帧间隔**: 2秒
- **CPU 使用预设**: veryfast
- **直播延迟**: 低延迟

## 访问地址

| 服务 | 地址 | 说明 |
|------|------|------|
| 直播页面 | `http://服务器IP:3000` | 用户观看直播的页面 |
| 管理后台 | `http://服务器IP:3000/console` | 管理员登录监控 |
| FLV 流 | `http://服务器IP:8080/live/live.flv` | FLV 直播流地址 |
| RTMP 推流 | `rtmp://服务器IP:1935/live/live` | OBS 推流地址 |

## API 接口

### 获取直播状态（公开）

```
GET /api/status
```

响应示例：
```json
{
  "success": true,
  "data": {
    "live": true,
    "viewers": 0,
    "startedAt": "2024-01-01T00:00:00.000Z",
    "bitrate": 5000,
    "server": {
      "flvUrl": "http://localhost:8080/live/live.flv",
      "rtmpUrl": "rtmp://localhost:1935/live/live"
    }
  }
}
```

### 管理员登录

```
POST /api/login
Content-Type: application/json

{
  "username": "admin",
  "password": "admin123"
}
```

### 启动/停止直播（需认证）

```
POST /api/stream/start
Header: x-admin-token: <token>

POST /api/stream/stop
Header: x-admin-token: <token>
```

## 目录结构

```
LiveStream/
├── server.js           # 主服务器入口
├── config.js           # 配置文件
├── package.json        # 项目依赖
├── patches/            # NMS 补丁文件
├── public/
│   ├── index.html      # 直播观看页面
│   └── console.html    # 管理后台页面
└── node_modules/       # 依赖包
```

## 浏览器兼容性

| 浏览器 | 版本 | FLV 支持 |
|--------|------|----------|
| Chrome | 70+ | ✅ 完整支持 |
| Firefox | 65+ | ✅ 完整支持 |
| Safari | 11+ | ✅ 完整支持 |
| Edge | 79+ | ✅ 完整支持 |
| iOS Safari | 11+ | ✅ 完整支持 |
| Android Chrome | 70+ | ✅ 完整支持 |

## 故障排查

### 1. 端口被占用

```bash
# 查看占用端口的进程
lsof -ti:1935,3000,8080

# 杀掉占用端口的进程
kill -9 $(lsof -ti:1935,3000,8080)
```

### 2. OBS 无法连接

- 检查服务器防火墙是否开放 1935 端口
- 确认服务器 IP 地址正确
- 验证密钥与 config.js 中的 channelName 一致
- 检查服务器是否正常运行

### 3. 网页无法播放

- 确认服务器 8080 端口可访问
- 检查 FLV URL 是否正确：`http://服务器IP:8080/live/live.flv`
- 清除浏览器缓存后重试
- 检查浏览器控制台错误信息
- 确认使用 HTTPS 时需要配置 SSL 证书

### 4. 直播延迟过高

- 使用 Chrome/Safari 等现代浏览器
- 检查网络带宽是否足够
- OBS 中设置低延迟模式
- 降低视频比特率

### 5. 管理后台无法登录

- 确认用户名密码正确（默认：admin / admin123）
- 检查浏览器是否禁用了 JavaScript
- 清除浏览器 LocalStorage 后重新登录
- Token 有效期为 24 小时，过期需重新登录

## 生产部署建议

### 使用 PM2 守护进程

```bash
npm install -g pm2
pm2 start server.js --name livestream
pm2 save
pm2 startup
```

### 使用 Nginx 反向代理

```nginx
# HTTP 配置
server {
    listen 80;
    server_name your-domain.com;
    
    # API 和静态文件
    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }
    
    # FLV 流媒体
    location /live/ {
        proxy_pass http://127.0.0.1:8080;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        # FLV 需要较长的超时时间
        proxy_read_timeout 600s;
        chunked_transfer_encoding off;
    }
}
```

### 防火墙配置

```bash
# 开放必要端口
sudo ufw allow 3000/tcp    # API 服务
sudo ufw allow 8080/tcp    # FLV 媒体服务
sudo ufw allow 1935/tcp    # RTMP 推流
sudo ufw reload
```

### SSL/HSTS 安全配置（生产环境）

```nginx
server {
    listen 443 ssl http2;
    server_name your-domain.com;
    
    ssl_certificate /path/to/cert.pem;
    ssl_certificate_key /path/to/key.pem;
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_ciphers HIGH:!aNULL:!MD5;
    
    # API 和静态文件
    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
    
    # FLV 流媒体
    location /live/ {
        proxy_pass http://127.0.0.1:8080;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 600s;
    }
}

server {
    listen 80;
    server_name your-domain.com;
    return 301 https://$host$request_uri;
}
```

## 技术栈

- **后端**: Node.js + Express
- **流媒体**: Node Media Server (NMS)
- **视频处理**: FFmpeg（NMS 内置使用）
- **前端播放器**: flv.js + hls.js（备用）
- **编码**: H.264 (AVC) + AAC

## 许可证

MIT License
