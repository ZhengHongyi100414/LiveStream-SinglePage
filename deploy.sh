#!/usr/bin/env bash
#
# LiveStream 一键部署脚本
# 兼容 Debian/Ubuntu 和 RHEL/CentOS/Fedora
# 用法:
#   sudo bash deploy.sh                     # 默认源
#   sudo bash deploy.sh --china             # 国内镜像加速
#   sudo bash deploy.sh --dir /path/to/dir  # 自定义安装目录
#
set -euo pipefail

# ── 颜色 ──────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'; NC='\033[0m'
info()  { echo -e "${CYAN}[INFO]${NC}  $*"; }
ok()    { echo -e "${GREEN}[OK]${NC}    $*"; }
warn()  { echo -e "${YELLOW}[WARN]${NC}  $*"; }
err()   { echo -e "${RED}[ERR]${NC}   $*" >&2; }
die()   { err "$*"; exit 1; }

# ── 参数解析 ──────────────────────────────────────────
INSTALL_DIR="/opt/LiveStream"
CHINA=0
while [[ $# -gt 0 ]]; do
    case "$1" in
        --dir)   INSTALL_DIR="$2"; shift 2 ;;
        --china) CHINA=1; shift ;;
        *) die "未知参数: $1 (支持: --china, --dir <路径>)" ;;
    esac
done

# ── 镜像地址 ──────────────────────────────────────────
# 国内模式下: Node.js 二进制走淘宝镜像, npm 包走淘宝 registry
GIT_REPO_URL="https://github.com/ZhengHongyi100414/LiveStream-SinglePage.git"
if [[ $CHINA -eq 1 ]]; then
    NODE_MIRROR="https://npmmirror.com/mirrors/node"
    NPM_REGISTRY="https://registry.npmmirror.com"
    info "🇨🇳 国内镜像加速模式 (Node/npm 走淘宝源)"
fi

# ── 权限检查 ──────────────────────────────────────────
[[ $EUID -eq 0 ]] || die "请使用 root 权限运行 (sudo bash deploy.sh)"

# ── 检测包管理器 ──────────────────────────────────────
detect_pkg_mgr() {
    if command -v apt-get &>/dev/null; then
        PKG_MGR="apt"
    elif command -v dnf &>/dev/null; then
        PKG_MGR="dnf"
    elif command -v yum &>/dev/null; then
        PKG_MGR="yum"
    else
        die "未检测到 apt/dnf/yum，暂不支持此系统"
    fi
    info "包管理器: $PKG_MGR"
}

# ── 安装基础依赖 ──────────────────────────────────────
install_base() {
    info "安装基础工具..."
    case "$PKG_MGR" in
        apt) apt-get update -qq && apt-get install -y -qq curl git ca-certificates xz-utils ;;
        dnf) dnf install -y -q curl git ca-certificates xz ;;
        yum) yum install -y -q curl git ca-certificates xz ;;
    esac
    ok "基础工具就绪"
}

# ── 安装 Node.js ─────────────────────────────────────
install_node() {
    if command -v node &>/dev/null; then
        local ver
        ver=$(node -v | sed 's/v//' | cut -d. -f1)
        if [[ $ver -ge 16 ]]; then
            ok "Node.js $(node -v) 已安装，跳过"
            # 国内模式下顺便设置 npm 镜像
            if [[ $CHINA -eq 1 ]]; then
                npm config set registry "$NPM_REGISTRY" 2>/dev/null || true
            fi
            return
        fi
        warn "Node.js 版本过低 ($(node -v))，将升级..."
    fi

    if [[ $CHINA -eq 1 ]]; then
        install_node_mirror
    else
        install_node_official
    fi

    ok "Node.js $(node -v) 安装完成"

    # 设置 npm 镜像
    if [[ $CHINA -eq 1 ]]; then
        npm config set registry "$NPM_REGISTRY"
        info "npm 镜像已设为 $NPM_REGISTRY"
    fi
}

# 官方源安装 (NodeSource)
install_node_official() {
    info "通过 NodeSource 安装 Node.js 18.x..."
    case "$PKG_MGR" in
        apt)
            curl -fsSL https://deb.nodesource.com/setup_18.x | bash -
            apt-get install -y -qq nodejs
            ;;
        dnf|yum)
            curl -fsSL https://rpm.nodesource.com/setup_18.x | bash -
            $PKG_MGR install -y -q nodejs
            ;;
    esac
}

# 国内镜像安装 (npmmirror 二进制)
install_node_mirror() {
    info "通过淘宝镜像安装 Node.js 18.x LTS..."

    # 获取最新 v18 版本号
    local version
    version=$(curl -fsSL "${NODE_MIRROR}/index.tab" 2>/dev/null \
        | grep -oP 'v18\.\d+\.\d+' | head -1) || true

    # 如果 tab 索引获取失败，用 SHASUMS 回退
    if [[ -z "$version" ]]; then
        version=$(curl -fsSL "${NODE_MIRROR}/latest-v18.x/" 2>/dev/null \
            | grep -oP 'node-v18\.\d+\.\d+' | head -1 | sed 's/node-//') || true
    fi

    # 最终回退：硬编码已知稳定版本
    if [[ -z "$version" ]]; then
        version="v18.20.4"
        warn "无法自动获取最新版本，使用 $version"
    fi

    local arch
    arch=$(uname -m)
    case "$arch" in
        x86_64)  arch="x64" ;;
        aarch64) arch="arm64" ;;
        armv7l)  arch="armv7l" ;;
        *) die "不支持的架构: $arch" ;;
    esac

    local filename="node-${version}-linux-${arch}"
    local url="${NODE_MIRROR}/${version}/${filename}.tar.xz"
    info "下载: $url"

    local tmp
    tmp=$(mktemp -d)
    curl -fSL --connect-timeout 30 --retry 3 "$url" -o "$tmp/node.tar.xz"
    tar -xJf "$tmp/node.tar.xz" -C "$tmp"
    cp -f "$tmp/${filename}/bin/node"     /usr/local/bin/node
    cp -f "$tmp/${filename}/bin/npm"      /usr/local/bin/npm
    cp -f "$tmp/${filename}/bin/npx"      /usr/local/bin/npx
    ln -sf /usr/local/bin/node /usr/bin/node 2>/dev/null || true
    ln -sf /usr/local/bin/npm  /usr/bin/npm   2>/dev/null || true
    ln -sf /usr/local/bin/npx  /usr/bin/npx   2>/dev/null || true
    # 复制 node_modules (npm 运行需要)
    mkdir -p /usr/local/lib/node_modules
    cp -rf "$tmp/${filename}/lib/node_modules/npm" /usr/local/lib/node_modules/
    rm -rf "$tmp"

    # 验证
    if ! command -v node &>/dev/null; then
        die "Node.js 安装失败"
    fi
}

# ── 安装 FFmpeg ───────────────────────────────────────
install_ffmpeg() {
    if command -v ffmpeg &>/dev/null && command -v ffprobe &>/dev/null; then
        ok "FFmpeg 已安装，跳过"
        return
    fi

    info "安装 FFmpeg..."
    case "$PKG_MGR" in
        apt)
            apt-get install -y -qq ffmpeg
            ;;
        dnf)
            local rhel_ver
            rhel_ver=$(rpm -E %{rhel} 2>/dev/null || echo "8")
            dnf install -y -q epel-release 2>/dev/null || true
            dnf install -y -q "https://download1.rpmfusion.org/free/el/rpmfusion-free-release-${rhel_ver}.noarch.rpm" 2>/dev/null || true
            dnf install -y -q ffmpeg || install_ffmpeg_static
            ;;
        yum)
            local rhel_ver
            rhel_ver=$(rpm -E %{rhel} 2>/dev/null || echo "7")
            yum install -y -q epel-release 2>/dev/null || true
            yum install -y -q "https://download1.rpmfusion.org/free/el/rpmfusion-free-release-${rhel_ver}.noarch.rpm" 2>/dev/null || true
            yum install -y -q ffmpeg || install_ffmpeg_static
            ;;
    esac

    if command -v ffmpeg &>/dev/null; then
        ok "FFmpeg 安装完成"
    else
        die "FFmpeg 安装失败"
    fi
}

# ── FFmpeg 静态二进制兜底 ─────────────────────────────
install_ffmpeg_static() {
    warn "包管理器安装 FFmpeg 失败，下载静态构建..."
    local arch
    arch=$(uname -m)
    local url
    case "$arch" in
        x86_64)  url="https://johnvansickle.com/ffmpeg/releases/ffmpeg-release-amd64-static.tar.xz" ;;
        aarch64) url="https://johnvansickle.com/ffmpeg/releases/ffmpeg-release-arm64-static.tar.xz" ;;
        *) die "不支持的架构: $arch" ;;
    esac

    local tmp
    tmp=$(mktemp -d)
    curl -fSL --connect-timeout 30 --retry 3 "$url" -o "$tmp/ffmpeg.tar.xz"
    tar -xJf "$tmp/ffmpeg.tar.xz" -C "$tmp"
    local bindir
    bindir=$(find "$tmp" -maxdepth 1 -type d -name 'ffmpeg-*' | head -1)
    install -m 755 "$bindir/ffmpeg"  /usr/local/bin/ffmpeg
    install -m 755 "$bindir/ffprobe" /usr/local/bin/ffprobe
    rm -rf "$tmp"
    ok "FFmpeg 静态构建安装到 /usr/local/bin/"
}

# ── 安装 PM2 ──────────────────────────────────────────
install_pm2() {
    if command -v pm2 &>/dev/null; then
        ok "PM2 $(pm2 -v) 已安装，跳过"
        return
    fi
    info "安装 PM2..."
    npm install -g pm2
    ok "PM2 $(pm2 -v) 安装完成"
}

# ── 部署项目 ──────────────────────────────────────────
deploy_project() {
    if [[ -d "$INSTALL_DIR/.git" ]]; then
        info "检测到已有仓库，拉取最新..."
        cd "$INSTALL_DIR"
        git pull --ff-only || warn "git pull 失败，使用现有代码"
    elif [[ -f "$INSTALL_DIR/package.json" ]]; then
        info "目录已存在且含 package.json，跳过克隆"
        cd "$INSTALL_DIR"
    else
        info "克隆项目到 $INSTALL_DIR..."
        git clone "$GIT_REPO_URL" "$INSTALL_DIR"
        cd "$INSTALL_DIR"
    fi

    info "安装 npm 依赖..."
    npm install --unsafe-perm

    # 自动修正 ffmpeg 路径
    local ffmpeg_path
    ffmpeg_path=$(which ffmpeg)
    if [[ "$ffmpeg_path" != "/usr/bin/ffmpeg" ]]; then
        sed -i "s|/usr/bin/ffmpeg|$ffmpeg_path|g" config.js
        info "已将 config.js 中 ffmpeg 路径修正为 $ffmpeg_path"
    fi

    ok "项目部署完成 → $INSTALL_DIR"
}

# ── 启动服务 ──────────────────────────────────────────
start_service() {
    cd "$INSTALL_DIR"
    pm2 delete livestream 2>/dev/null || true

    info "启动 LiveStream..."
    pm2 start server.js --name livestream --max-memory-restart 512M
    pm2 save

    pm2 startup systemd -u root --hp /root 2>/dev/null \
        || pm2 startup 2>/dev/null \
        || warn "PM2 开机自启设置失败，可手动执行: pm2 startup"

    ok "服务已启动"
}

# ── 防火墙 ────────────────────────────────────────────
open_firewall() {
    info "配置防火墙..."
    local opened=0

    if command -v ufw &>/dev/null && ufw status 2>/dev/null | grep -q "active"; then
        ufw allow 3000/tcp 2>/dev/null && opened=1
        ufw allow 8080/tcp 2>/dev/null
        ufw allow 1935/tcp 2>/dev/null
        ufw reload 2>/dev/null
    fi

    if command -v firewall-cmd &>/dev/null && firewall-cmd --state &>/dev/null; then
        firewall-cmd --permanent --add-port=3000/tcp 2>/dev/null && opened=1
        firewall-cmd --permanent --add-port=8080/tcp 2>/dev/null
        firewall-cmd --permanent --add-port=1935/tcp 2>/dev/null
        firewall-cmd --reload 2>/dev/null
    fi

    if command -v iptables &>/dev/null && ! iptables -C INPUT -p tcp --dport 3000 -j ACCEPT 2>/dev/null; then
        iptables -I INPUT -p tcp --dport 3000 -j ACCEPT 2>/dev/null && opened=1
        iptables -I INPUT -p tcp --dport 8080 -j ACCEPT 2>/dev/null
        iptables -I INPUT -p tcp --dport 1935 -j ACCEPT 2>/dev/null
        if command -v iptables-save &>/dev/null; then
            iptables-save > /etc/iptables/rules.v4 2>/dev/null || true
        fi
    fi

    [[ $opened -eq 1 ]] && ok "防火墙端口已开放 (3000/8080/1935)" || info "未检测到活跃防火墙或端口已开放"
}

# ── 打印摘要 ──────────────────────────────────────────
print_summary() {
    local ip
    ip=$(hostname -I 2>/dev/null | awk '{print $1}' || echo "<服务器IP>")

    echo ""
    echo -e "${GREEN}══════════════════════════════════════════════════${NC}"
    echo -e "${GREEN}  ✅ LiveStream 部署完成！${NC}"
    echo -e "${GREEN}══════════════════════════════════════════════════${NC}"
    echo ""
    echo -e "  网页播放:   ${CYAN}http://${ip}:3000${NC}"
    echo -e "  管理后台:   ${CYAN}http://${ip}:3000/console${NC}"
    echo -e "  状态 API:   ${CYAN}http://${ip}:3000/api/status${NC}"
    echo ""
    echo -e "  RTMP 推流:  ${CYAN}rtmp://${ip}:1935/live/live${NC}"
    echo -e "  FLV 播放:   ${CYAN}http://${ip}:8080/live/live.flv${NC}"
    echo -e "  HLS 播放:   ${CYAN}http://${ip}:8080/live/live/index.m3u8${NC}"
    echo ""
    echo -e "  OBS 推流配置:"
    echo -e "    服务器:  rtmp://${ip}:1935/live"
    echo -e "    密钥:    live"
    echo ""
    echo -e "  ${YELLOW}默认账号: admin / admin123  (请尽快修改！)${NC}"
    echo ""
    echo -e "  常用命令:"
    echo -e "    pm2 status              # 查看状态"
    echo -e "    pm2 logs livestream     # 查看日志"
    echo -e "    pm2 restart livestream  # 重启"
    echo -e "    pm2 stop livestream     # 停止"
    echo ""
    echo -e "${GREEN}══════════════════════════════════════════════════${NC}"
}

# ── 主流程 ────────────────────────────────────────────
main() {
    echo ""
    echo -e "${CYAN}  LiveStream 一键部署${NC}"
    echo -e "${CYAN}  兼容 Debian/Ubuntu · RHEL/CentOS/Fedora${NC}"
    echo ""

    detect_pkg_mgr
    install_base
    install_node
    install_ffmpeg
    install_pm2
    deploy_project
    start_service
    open_firewall
    print_summary
}

main
