# 单频道在线直播服务系统

基于 Node.js + Node Media Server + FFmpeg 构建的单频道直播服务系统，支持 OBS/设备 RTMP 推流，服务端实时转码（自适应码率 + 分辨率放大），客户端 HLS/FLV 双协议播放。

## 系统架构

```
┌─────────────┐     RTMP推流      ┌──────────────────────────────────────┐
│  OBS/推流设备 │ ─────────────────> │        Node Media Server (1935)       │
└─────────────┘                    │                                      │
                                   │  ┌────────────────────────────────┐  │
                                   │  │  FLV 流媒体分发 (8080)          │  │
                                   │  └────────────────────────────────┘  │
                                   └──────────────┬───────────────────────┘
                                                  │ RTMP 内部转发
                                                  ▼
                                   ┌──────────────────────────────────────┐
                                   │     FFmpeg 转码器 (服务端自管理)       │
                                   │  · libx264 重编码 (CRF 恒定质量)      │
                                   │  · 720p → 1080p 放大 (fast_bilinear)  │
                                   │  · 自适应帧率/质量                    │
                                   │  · HLS 切片输出 (.m3u8 + .ts)         │
                                   └──────────────┬───────────────────────┘
                                                  │ HLS
┌─────────────┐  HLS/FLV                         │
│  网页播放器   │ <─────────────────────────────────┘
│  (index.html)│  播放优先级: 原生HLS → hls.js → FLV
└─────────────┘
                                  ┌──────────────────────────────────────┐
┌─────────────┐  API              │     Express API (3000)                │
│  管理后台    │ <────────────────> │  · 直播状态监控 (含输入/输出参数)     │
│ (console.html)│                  │  · 直播控制 (启停)                    │
└─────────────┘                   │  · 转码设置 (分辨率/帧率/质量)        │
                                  │  · ffprobe 实时探测码率/分辨率/帧率   │
                                  └──────────────────────────────────────┘
```

## 功能特性

- **RTMP 推流接收**：支持 OBS、FFmpeg、硬件编码器等 RTMP 协议推流
- **服务端实时转码**：FFmpeg libx264 重编码，CRF 恒定质量模式
- **分辨率放大**：720p 推流可放大到 1080p（fast_bilinear 插值），4K 屏观感更好
- **自适应码率**：CRF 模式自动适应内容复杂度，静态省带宽、动态保画质
- **HLS + FLV 双协议**：HLS 为主（hls.js），FLV 为备用回退
- **转码设置面板**：管理后台可调输出分辨率/帧率/质量（直播未开始时）
- **实时监控**：ffprobe 探测输入(OBS推流)和输出(.ts切片)的码率/分辨率/帧率
- **断流自动检测**：probe 连续失败自动判定 OFFLINE（兜底 postUnPublish 不触发）
- **响应式播放页面**：支持桌面和移动端，含硬件加速开关、格式选择器
- **API 认证保护**：管理接口需要登录认证

## 环境要求

- **操作系统**：Linux（推荐 Ubuntu 20.04+）、macOS、Windows
- **Node.js**：>= 16.0.0
- **FFmpeg**：>= 4.0（含 ffprobe）

## 一键部署

提供自动化部署脚本，一条命令完成 Node.js、FFmpeg、PM2 安装 + 项目克隆 + 服务启动 + 防火墙配置。

### Linux / macOS

```bash
# 默认源
curl -fsSL https://raw.githubusercontent.com/ZhengHongyi100414/LiveStream-SinglePage/main/deploy.sh | sudo bash

# 国内服务器加速（Node/npm 走淘宝镜像）
curl -fsSL https://raw.githubusercontent.com/ZhengHongyi100414/LiveStream-SinglePage/main/deploy.sh | sudo bash -s -- --china

# 自定义安装目录
curl -fsSL https://raw.githubusercontent.com/ZhengHongyi100414/LiveStream-SinglePage/main/deploy.sh | sudo bash -s -- --china --dir /home/jay/LiveStream
```

支持 Debian/Ubuntu、RHEL/CentOS/Fedora、macOS，自动检测包管理器。

### Windows Server

```powershell
# 以管理员身份运行 PowerShell
Set-ExecutionPolicy Bypass -Scope Process -Force
Invoke-WebRequest -Uri "https://raw.githubusercontent.com/ZhengHongyi100414/LiveStream-SinglePage/main/deploy.ps1" -OutFile deploy.ps1

# 默认
.\deploy.ps1

# 国内加速
.\deploy.ps1 -China

# 自定义目录
.\deploy.ps1 -China -Dir "D:\LiveStream"
```

通过 Chocolatey 安装 Node.js 和 FFmpeg，PM2 + pm2-windows-startup 管理进程。

## 保姆级部署教程

### 第一步：安装系统依赖

#### Ubuntu / Debian

```bash
# 更新包管理器
sudo apt update

# 安装 Node.js 18.x LTS
curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
sudo apt install -y nodejs

# 安装 FFmpeg（含 ffprobe）
sudo apt install -y ffmpeg

# 验证安装
node -v          # 应显示 v18.x.x
npm -v           # 应显示 9.x.x 或 10.x.x
ffmpeg -version  # 应显示版本号
ffprobe -version # 应显示版本号
```

#### CentOS / RHEL

```bash
# 安装 Node.js 18.x LTS
curl -fsSL https://rpm.nodesource.com/setup_18.x | sudo bash -
sudo yum install -y nodejs

# 安装 FFmpeg（需要 EPEL 和 RPM Fusion）
sudo yum install -y epel-release
sudo yum install -y https://download1.rpmfusion.org/free/el/rpmfusion-free-release-$(rpm -E %rhel).noarch.rpm
sudo yum install -y ffmpeg

# 验证
node -v && npm -v && ffmpeg -version
```

#### macOS

```bash
# 安装 Homebrew（如未安装）
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"

# 安装 Node.js 和 FFmpeg
brew install node@18 ffmpeg

# 验证
node -v && npm -v && ffmpeg -version
```

### 第二步：获取项目代码

```bash
# 方式一：git clone（如有仓库）
git clone <你的仓库地址> LiveStream
cd LiveStream

# 方式二：直接拷贝项目文件到服务器
# 将项目文件夹上传到服务器，例如 /opt/LiveStream
cd /opt/LiveStream
```

### 第三步：安装项目依赖

```bash
npm install
```

> 安装时会自动执行 `patch-package` 应用 node-media-server 的补丁。

### 第四步：配置系统

编辑 `config.js`：

```javascript
module.exports = {
    http: {
        port: 8080,          // 媒体服务端口（HTTP-FLV / HLS）
        allow_origin: '*',
        mediaroot: './public',
    },
    rtmp: {
        port: 1935,          // RTMP 推流接收端口
        chunk_size: 60000,
        gop_cache: true,
        ping: 30,
        ping_timeout: 60,
    },
    hls: {
        enabled: true,       // 启用 HLS
        m3u8_cache: true,
        m3u8_maxKeep: 10,
        hls_allow_origin: '*',
    },
    trans: {
        ffmpeg: '/usr/bin/ffmpeg',  // FFmpeg 路径（用 which ffmpeg 确认）
        tasks: [],                   // 留空，转码由 server.js 自管理
    },
    admin: {
        username: 'admin',      // 管理后台用户名
        password: 'admin123',   // 管理后台密码（生产环境务必修改！）
    },
    api: {
        port: 3000,             // API + 网页服务端口
    },
    stream: {
        channelName: 'live',    // 频道名称（推流密钥）
    },
};
```

**需要确认的配置项**：
1. `ffmpeg` 路径：运行 `which ffmpeg` 确认，通常 `/usr/bin/ffmpeg`
2. `admin.password`：**生产环境务必修改默认密码**
3. 端口：确保 3000、8080、1935 未被占用

### 第五步：启动服务

#### 开发模式（前台运行，看日志）

```bash
npm start
```

启动成功会显示：

```
========================================
  单频道直播服务系统已启动
========================================
  网页播放地址: http://localhost:3000
  管理后台地址: http://localhost:3000/console
  API服务端口:  3000
  媒体服务端口: 8080
  RTMP推流地址: rtmp://localhost:1935/live/live
  FLV播放地址:  http://localhost:8080/live/live.flv
  HLS播放地址:  http://localhost:8080/live/live/index.m3u8
========================================
```

#### 生产模式（PM2 守护进程）

```bash
# 安装 PM2
sudo npm install -g pm2

# 启动服务
pm2 start server.js --name livestream

# 设置开机自启
pm2 save
pm2 startup

# 常用命令
pm2 status              # 查看状态
pm2 logs livestream     # 查看日志
pm2 restart livestream  # 重启
pm2 stop livestream     # 停止
```

### 第六步：配置 OBS 推流

1. 打开 OBS 软件
2. 进入 **设置** → **推流**
3. 配置：
   - **服务**：自定义
   - **服务器**：`rtmp://你的服务器IP:1935/live`
   - **串流密钥**：`live`

**推荐编码设置**（设置 → 输出 → 高级模式）：

| 参数 | 推荐值 | 说明 |
|------|--------|------|
| 视频编码器 | x264 / 硬件编码器 | 有独立显卡选硬件编码器 |
| 视频比特率 | 4000-6000 Kbps | 720p 推荐 4000，1080p 推荐 6000 |
| 关键帧间隔 | 2 秒 | 对齐 HLS 切片时间 |
| 编码预设 | veryfast | 平衡 CPU 和画质 |
| 音频编码器 | AAC | |
| 音频比特率 | 128-192 Kbps | |

4. 点击"开始推流"

### 第七步：验证直播

1. **打开播放页面**：浏览器访问 `http://服务器IP:3000`
2. **打开管理后台**：浏览器访问 `http://服务器IP:3000/console`，用 admin/admin123 登录
3. 在管理后台可以看到：
   - 直播状态（LIVE/OFFLINE）
   - 观看人数
   - 输入参数（OBS 推流的分辨率/帧率/码率）
   - 推送输出（.ts 切片实际的分辨率/帧率/码率）
   - 直播时长

## 转码设置

在管理后台的"转码设置"面板（直播未开始时可调整）：

| 设置 | 选项 | 说明 |
|------|------|------|
| 输出分辨率 | 1080p（放大）/ 720p（原始）| 720p 放大到 1080p，4K 屏观感更好 |
| 帧率 | 24 / 30 / 60 fps | 60fps 更流畅但 CPU 开销大 |
| 质量 | CRF 18/20/23/28 | 18=高，28=低，CRF 越低画质越好码率越高 |

**CRF 质量参考**：
- CRF 18：接近视觉无损，码率最高（推荐带宽充足时）
- CRF 20：高质量，码率适中（默认，推荐）
- CRF 23：中等质量，码率较低
- CRF 28：低质量，码率最低（CPU 紧张时）

**CPU 开销说明**：
- 720p（不放大）：CPU 最低
- 1080p（放大）：CPU 约增加 50-100%
- 60fps：CPU 约比 30fps 多 50%
- CRF 越低，码率越高，编码略慢

> 直播开始后转码设置会自动锁定，需停止直播后才能修改。

## 访问地址

| 服务 | 地址 | 说明 |
|------|------|------|
| 直播页面 | `http://服务器IP:3000` | 用户观看直播 |
| 管理后台 | `http://服务器IP:3000/console` | 管理员监控+设置 |
| HLS 流 | `http://服务器IP:8080/live/live/index.m3u8` | HLS 直播流 |
| FLV 流 | `http://服务器IP:8080/live/live.flv` | FLV 直播流（备用） |
| RTMP 推流 | `rtmp://服务器IP:1935/live/live` | OBS 推流地址 |
| 状态 API | `http://服务器IP:3000/api/status` | 直播状态 JSON |

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
    "viewers": 3,
    "startedAt": "2025-08-01T12:00:00.000Z",
    "resolution": "1280x720",
    "fps": 30,
    "videoBitrate": 4096,
    "audioBitrate": 197,
    "outputResolution": "1920x1080",
    "outputFps": 30,
    "outputBitrate": 5200,
    "server": {
      "flvUrl": "http://host:8080/live/live.flv",
      "hlsUrl": "http://host:8080/live/live/index.m3u8",
      "rtmpUrl": "rtmp://host:1935/live/live"
    }
  }
}
```

### 管理员登录

```
POST /api/login
Content-Type: application/json

{ "username": "admin", "password": "admin123" }
```

返回 `{ "success": true, "token": "admin-token-xxx" }`

### 启动/停止直播（需认证）

```
POST /api/stream/start
Header: x-admin-token: <token>

POST /api/stream/stop
Header: x-admin-token: <token>
```

### 转码设置（需认证）

```
GET /api/transcode/settings
Header: x-admin-token: <token>

POST /api/transcode/settings
Header: x-admin-token: <token>
Content-Type: application/json

{ "resolution": "1080p", "fps": 30, "crf": 20 }
```

> POST 仅在直播未开始时可修改。

## Nginx 反向代理（生产环境）

```nginx
server {
    listen 80;
    server_name your-domain.com;

    # API 和静态文件
    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    }

    # HLS / FLV 流媒体
    location /live/ {
        proxy_pass http://127.0.0.1:8080;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        # 流媒体需要长超时
        proxy_read_timeout 600s;
        proxy_buffering off;           # 关闭缓冲，降低延迟
        chunked_transfer_encoding off;  # FLV 需要
    }
}
```

### HTTPS 配置

```nginx
server {
    listen 443 ssl http2;
    server_name your-domain.com;

    ssl_certificate /path/to/cert.pem;
    ssl_certificate_key /path/to/key.pem;
    ssl_protocols TLSv1.2 TLSv1.3;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    location /live/ {
        proxy_pass http://127.0.0.1:8080;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 600s;
        proxy_buffering off;
    }
}

# HTTP 跳转 HTTPS
server {
    listen 80;
    server_name your-domain.com;
    return 301 https://$host$request_uri;
}
```

## 防火墙配置

```bash
# Ubuntu (ufw)
sudo ufw allow 3000/tcp    # API + 网页
sudo ufw allow 8080/tcp    # HLS + FLV 流媒体
sudo ufw allow 1935/tcp    # RTMP 推流
sudo ufw reload

# CentOS (firewalld)
sudo firewall-cmd --permanent --add-port=3000/tcp
sudo firewall-cmd --permanent --add-port=8080/tcp
sudo firewall-cmd --permanent --add-port=1935/tcp
sudo firewall-cmd --reload
```

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
- 验证密钥与 config.js 中的 channelName 一致（默认 `live`）
- 检查服务器是否正常运行：`pm2 status` 或 `ps aux | grep node`

### 3. 网页无法播放

- 确认 8080 端口可访问
- 打开浏览器控制台（F12）查看错误
- 尝试切换播放格式（设置菜单 → 播放格式 → FLV）
- 确认 OBS 正在推流（管理后台显示 LIVE）

### 4. 画质模糊

- 检查管理后台"推送输出"码率：如果低于 1Mbps 说明内容静态（CRF 自动降码率，正常）
- 在转码设置里调高质量（CRF 18）或调高 OBS 推流码率
- 如果 CPU 充裕，选 1080p 放大
- 如果 CPU 紧张，选 720p（不放大）+ CRF 23

### 5. CPU 占用过高

- 转码设置选 720p（不放大）+ CRF 28 + 24fps
- 或降低 OBS 推流分辨率
- FFmpeg 使用 ultrafast preset（已是最快）

### 6. 直播状态显示不更新

- probe 每 5 秒探测一次，最多 10 秒延迟
- OBS 异常断开时，probe 连续失败 2 次后自动判定 OFFLINE
- 检查日志：`pm2 logs livestream` 或 `tail -f /tmp/liveserver.log`

### 7. 管理后台无法登录

- 确认用户名密码正确（默认 admin / admin123）
- Token 有效期 24 小时，过期需重新登录
- 清除浏览器 LocalStorage 后重试

## 目录结构

```
LiveStream/
├── server.js              # 主服务器（API + 流媒体 + FFmpeg 转码管理）
├── config.js              # 配置文件（端口/密码/频道名）
├── package.json           # 项目依赖
├── package-lock.json      # 依赖版本锁定
├── patches/               # node-media-server 补丁
├── logo.png               # 网站 Logo
├── public/
│   ├── index.html         # 直播观看页面（HLS + FLV 播放器）
│   ├── console.html       # 管理后台页面（监控 + 转码设置）
│   └── live/              # HLS 切片输出目录（自动生成）
│       └── live/
│           ├── index.m3u8
│           └── *.ts
└── node_modules/          # 依赖包
```

## 技术栈

| 组件 | 技术 | 说明 |
|------|------|------|
| 后端 | Node.js + Express | API 服务、静态文件、转码管理 |
| 流媒体 | Node Media Server | RTMP 接收、HTTP-FLV 分发 |
| 转码 | FFmpeg (libx264) | 实时重编码、分辨率放大、HLS 切片 |
| 探测 | ffprobe | 实时码率/分辨率/帧率监控 |
| 前端播放 | hls.js + flv.js | HLS 为主，FLV 备用 |
| 编码格式 | H.264 (AVC) + AAC | 浏览器全平台兼容 |

## 浏览器兼容性

| 浏览器 | 版本 | HLS | FLV |
|--------|------|-----|------|
| Chrome | 70+ | hls.js | flv.js |
| Firefox | 65+ | hls.js | flv.js |
| Safari | 11+ | 原生 | flv.js |
| Edge | 79+ | hls.js | flv.js |
| iOS Safari | 11+ | 原生 | 不支持 |
| Android Chrome | 70+ | hls.js | flv.js |

## 许可证

MIT License
