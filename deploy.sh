#!/usr/bin/env bash
# ============================================================
#  单频道在线直播服务系统 —— 一键部署脚本
#  兼容 Debian/Ubuntu 和 RHEL/CentOS/Fedora
#  用法: sudo bash deploy.sh
# ============================================================
set -euo pipefail

# ---------- 颜色与日志 ----------
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'; NC='\033[0m'
info()  { echo -e "${CYAN}[INFO]${NC}  $*"; }
ok()    { echo -e "${GREEN}[OK]${NC}    $*"; }
warn()  { echo -e "${YELLOW}[WARN]${NC}  $*"; }
err()   { echo -e "${RED}[ERROR]${NC} $*" >&2; }
die()   { err "$*"; exit 1; }

# ---------- 前置检查 ----------
[[ $EUID -eq 0 ]] || die "请使用 root 权限运行: sudo bash deploy.sh"

# ---------- 检测发行版 ----------
detect_os() {
    if [[ -f /etc/os-release ]]; then
        . /etc/os-release
        OS_ID="${ID,,}"          # 小写
        OS_LIKE="${ID_LIKE:-$OS_ID}"
        OS_LIKE="${OS_LIKE,,}"
        OS_VERSION="${VERSION_ID:-unknown}"
    elif command -v lsb_release &>/dev/null; then
        OS_ID=$(lsb_release -si | tr '[:upper:]' '[:lower:]')
        OS_LIKE="$OS_ID"
        OS_VERSION=$(lsb_release -sr)
    else
        die "无法检测操作系统发行版"
    fi

    if [[ "$OS_LIKE" == *"debian"* || "$OS_LIKE" == *"ubuntu"* || "$OS_ID" == "debian" || "$OS_ID" == "ubuntu" || "$OS_ID" == "linuxmint" || "$OS_ID" == "deepin" || "$OS_ID" == "kali" ]]; then
        PKG_TYPE="deb"
    elif [[ "$OS_LIKE" == *"rhel"* || "$OS_LIKE" == *"fedora"* || "$OS_LIKE" == *"centos"* || "$OS_ID" == "rhel" || "$OS_ID" == "centos" || "$OS_ID" == "fedora" || "$OS_ID" == "rocky" || "$OS_ID" == "almalinux" || "$OS_ID" == "ol" ]]; then
        PKG_TYPE="rpm"
    else
        warn "未识别的发行版 ($OS_ID)，尝试按 Debian 方式处理"
        PKG_TYPE="deb"
    fi

    info "检测到系统: $OS_ID $OS_VERSION (包管理: $PKG_TYPE)"
}

# ---------- 包管理器封装 ----------
pkg_update() {
    if [[ "$PKG_TYPE" == "deb" ]]; then
        apt-get update -qq
    else
        if command -v dnf &>/dev/null; then
            dnf makecache -q
        else
            yum makecache -q
        fi
    fi
}

pkg_install() {
    if [[ "$PKG_TYPE" == "deb" ]]; then
        apt-get install -y -qq "$@"
    else
        if command -v dnf &>/dev/null; then
            dnf install -y -q "$@"
        else
            yum install -y -q "$@"
        fi
    fi
}

# ---------- 安装基础工具 ----------
install_base_tools() {
    info "安装基础工具 (curl, git, ca-certificates) ..."
    if [[ "$PKG_TYPE" == "deb" ]]; then
        pkg_install curl git ca-certificates gnupg
    else
        pkg_install curl git ca-certificates gnupg2
    fi
    ok "基础工具就绪"
}

# ---------- 安装 Node.js 18.x ----------
install_nodejs() {
    if command -v node &>/dev/null; then
        local ver
        ver=$(node -v | sed 's/v//' | cut -d. -f1)
        if (( ver >= 16 )); then
            ok "Node.js 已安装: $(node -v) (满足 >=16 要求)"
            return
        else
            warn "Node.js 版本过低 ($(node -v))，将安装 18.x ..."
        fi
    fi

    info "安装 Node.js 18.x LTS ..."
    if [[ "$PKG_TYPE" == "deb" ]]; then
        curl -fsSL https://deb.nodesource.com/setup_18.x | bash -
        apt-get install -y -qq nodejs
    else
        curl -fsSL https://rpm.nodesource.com/setup_18.x | bash -
        if command -v dnf &>/dev/null; then
            dnf install -y -q nodejs
        else
            yum install -y -q nodejs
        fi
    fi
    ok "Node.js $(node -v) 安装完成"
}

# ---------- 安装 FFmpeg ----------
install_ffmpeg() {
    if command -v ffmpeg &>/dev/null && command -v ffprobe &>/dev/null; then
        ok "FFmpeg 已安装: $(ffmpeg -version 2>&1 | head -1 | awk '{print $3}')"
        return
    fi

    info "安装 FFmpeg ..."
    if [[ "$PKG_TYPE" == "deb" ]]; then
        pkg_install ffmpeg
    else
        # RHEL/CentOS 需要 RPM Fusion
        local rhel_ver
        rhel_ver=$(rpm -E %{rhel} 2>/dev/null || echo "8")

        # 尝试安装 EPEL
        pkg_install epel-release 2>/dev/null || true

        # 尝试安装 RPM Fusion（免费）
        if ! rpm -q rpmfusion-free-release &>/dev/null; then
            pkg_install "https://download1.rpmfusion.org/free/el/rpmfusion-free-release-${rhel_ver}.noarch.rpm" 2>/dev/null || {
                warn "RPM Fusion 安装失败，尝试从 EPEL 安装 ffmpeg ..."
            }
        fi

        if command -v dnf &>/dev/null; then
            dnf install -y -q ffmpeg 2>/dev/null || {
                warn "dnf 安装 ffmpeg 失败，尝试静态构建 ..."
                install_ffmpeg_static
                return
            }
        else
            yum install -y -q ffmpeg 2>/dev/null || {
                warn "yum 安装 ffmpeg 失败，尝试静态构建 ..."
                install_ffmpeg_static
                return
            }
        fi
    fi

    if command -v ffmpeg &>/dev/null && command -v ffprobe &>/dev/null; then
        ok "FFmpeg $(ffmpeg -version 2>&1 | head -1 | awk '{print $3}') 安装完成"
    else
        die "FFmpeg 安装失败，请手动安装后重试"
    fi
}

# 静态 FFmpeg 兜底（适用于无法通过包管理器安装的场景）
install_ffmpeg_static() {
    info "下载静态 FFmpeg ..."
    local arch
    arch=$(uname -m)
    local url
    if [[ "$arch" == "x86_64" ]]; then
        url="https://johnvansickle.com/ffmpeg/releases/ffmpeg-release-amd64-static.tar.xz"
    elif [[ "$arch" == "aarch64" ]]; then
        url="https://johnvansickle.com/ffmpeg/releases/ffmpeg-release-arm64-static.tar.xz"
    else
        die "不支持的架构: $arch，无法安装静态 FFmpeg"
    fi

    local tmpdir
    tmpdir=$(mktemp -d)
    curl -fSL "$url" -o "$tmpdir/ffmpeg.tar.xz"
    tar -xJf "$tmpdir/ffmpeg.tar.xz" -C "$tmpdir"
    local bin_dir
    bin_dir=$(find "$tmpdir" -maxdepth 1 -type d -name 'ffmpeg-*' | head -1)
    cp "$bin_dir/ffmpeg" "$bin_dir/ffprobe" /usr/local/bin/
    chmod +x /usr/local/bin/ffmpeg /usr/local/bin/ffprobe
    rm -rf "$tmpdir"

    # 覆盖 config.js 中的 ffmpeg 路径
    FFMPEG_PATH="/usr/local/bin/ffmpeg"
    ok "静态 FFmpeg 安装到 /usr/local/bin/"
}

# ---------- 安装 PM2 ----------
install_pm2() {
    if command -v pm2 &>/dev/null; then
        ok "PM2 已安装: $(pm2 -v)"
        return
    fi
    info "安装 PM2 进程管理器 ..."
    npm install -g pm2
    ok "PM2 $(pm2 -v) 安装完成"
}

# ---------- 部署项目 ----------
deploy_project() {
    local install_dir="${INSTALL_DIR:-/opt/LiveStream}"

    if [[ -d "$install_dir/.git" ]]; then
        info "检测到已有项目目录，拉取最新代码 ..."
        cd "$install_dir"
        git pull --ff-only 2>/dev/null || {
            warn "git pull 失败，跳过更新"
        }
    elif [[ -d "$install_dir" ]] && [[ -f "$install_dir/package.json" ]]; then
        info "使用已有项目目录: $install_dir"
        cd "$install_dir"
    else
        info "克隆项目到 $install_dir ..."
        mkdir -p "$(dirname "$install_dir")"
        git clone https://github.com/ZhengHongyi100414/LiveStream-SinglePage.git "$install_dir"
        cd "$install_dir"
    fi

    PROJECT_DIR="$install_dir"

    info "安装 npm 依赖 (含 patch-package 补丁) ..."
    npm install --unsafe-perm 2>&1 | tail -5

    # 如果 FFmpeg 不在默认路径，更新 config.js
    if [[ -n "${FFMPEG_PATH:-}" ]]; then
        sed -i "s|ffmpeg: '/usr/bin/ffmpeg'|ffmpeg: '$FFMPEG_PATH'|" config.js
        info "已更新 config.js 中的 ffmpeg 路径为 $FFMPEG_PATH"
    fi

    # 确保 config.js 中的 ffmpeg 路径与实际一致
    local actual_ffmpeg
    actual_ffmpeg=$(which ffmpeg)
    if [[ "$actual_ffmpeg" != "/usr/bin/ffmpeg" ]]; then
        sed -i "s|ffmpeg: '/usr/bin/ffmpeg'|ffmpeg: '$actual_ffmpeg'|" config.js
        info "已更新 ffmpeg 路径: $actual_ffmpeg"
    fi

    ok "项目部署完成: $PROJECT_DIR"
}

# ---------- 启动服务 ----------
start_service() {
    cd "$PROJECT_DIR"

    # 停止旧进程（如果存在）
    pm2 delete livestream 2>/dev/null || true

    info "使用 PM2 启动服务 ..."
    pm2 start server.js --name livestream --max-memory-restart 512M

    # 保存进程列表 + 设置开机自启
    pm2 save
    pm2 startup systemd -u root --hp /root 2>/dev/null || pm2 startup 2>/dev/null || warn "PM2 开机自启设置失败，可手动执行 pm2 startup"

    ok "服务已启动"
}

# ---------- 配置防火墙 ----------
configure_firewall() {
    info "配置防火墙规则 ..."

    if command -v ufw &>/dev/null && ufw status | grep -q "active"; then
        info "检测到 UFW，添加规则 ..."
        ufw allow 3000/tcp comment "LiveStream API" 2>/dev/null
        ufw allow 8080/tcp comment "LiveStream HLS/FLV" 2>/dev/null
        ufw allow 1935/tcp comment "LiveStream RTMP" 2>/dev/null
        ufw reload 2>/dev/null
        ok "UFW 规则已添加"
    elif command -v firewall-cmd &>/dev/null && firewall-cmd --state &>/dev/null; then
        info "检测到 firewalld，添加规则 ..."
        firewall-cmd --permanent --add-port=3000/tcp 2>/dev/null
        firewall-cmd --permanent --add-port=8080/tcp 2>/dev/null
        firewall-cmd --permanent --add-port=1935/tcp 2>/dev/null
        firewall-cmd --reload 2>/dev/null
        ok "firewalld 规则已添加"
    elif command -v iptables &>/dev/null; then
        # 检查 iptables 是否有活跃规则
        if iptables -L INPUT -n 2>/dev/null | grep -q "DROP\|REJECT"; then
            info "检测到 iptables，添加规则 ..."
            iptables -I INPUT -p tcp --dport 3000 -j ACCEPT 2>/dev/null
            iptables -I INPUT -p tcp --dport 8080 -j ACCEPT 2>/dev/null
            iptables -I INPUT -p tcp --dport 1935 -j ACCEPT 2>/dev/null
            # 尝试持久化
            if command -v iptables-save &>/dev/null; then
                mkdir -p /etc/iptables
                iptables-save > /etc/iptables/rules.v4 2>/dev/null || true
            fi
            ok "iptables 规则已添加"
        else
            info "未检测到活跃的防火墙，跳过"
        fi
    else
        info "未检测到防火墙，跳过配置"
    fi
}

# ---------- 打印部署信息 ----------
print_summary() {
    local ip
    ip=$(hostname -I 2>/dev/null | awk '{print $1}' || echo "YOUR_SERVER_IP")

    echo ""
    echo -e "${GREEN}========================================${NC}"
    echo -e "${GREEN}  部署完成!${NC}"
    echo -e "${GREEN}========================================${NC}"
    echo ""
    echo -e "  ${CYAN}网页播放地址:${NC}  http://${ip}:3000"
    echo -e "  ${CYAN}管理后台地址:${NC}  http://${ip}:3000/console"
    echo -e "  ${CYAN}API 状态接口:${NC}  http://${ip}:3000/api/status"
    echo ""
    echo -e "  ${CYAN}RTMP 推流地址:${NC}  rtmp://${ip}:1935/live/live"
    echo -e "  ${CYAN}FLV 播放地址:${NC}   http://${ip}:8080/live/live.flv"
    echo -e "  ${CYAN}HLS 播放地址:${NC}   http://${ip}:8080/live/live/index.m3u8"
    echo ""
    echo -e "  ${CYAN}OBS 推流配置:${NC}"
    echo -e "    服务器: rtmp://${ip}:1935/live"
    echo -e "    密钥:   live"
    echo ""
    echo -e "  ${YELLOW}管理后台默认账号:${NC} admin / admin123"
    echo -e "  ${RED}请尽快修改默认密码!${NC} (编辑 ${PROJECT_DIR}/config.js)"
    echo ""
    echo -e "  ${CYAN}常用命令:${NC}"
    echo -e "    pm2 status              # 查看服务状态"
    echo -e "    pm2 logs livestream     # 查看日志"
    echo -e "    pm2 restart livestream  # 重启服务"
    echo -e "    pm2 stop livestream     # 停止服务"
    echo -e "    pm2 monit              # 实时监控"
    echo ""
    echo -e "${GREEN}========================================${NC}"
}

# ---------- 主流程 ----------
main() {
    echo ""
    echo -e "${CYAN}================================================${NC}"
    echo -e "${CYAN}  单频道在线直播服务系统 - 一键部署${NC}"
    echo -e "${CYAN}================================================${NC}"
    echo ""

    detect_os
    install_base_tools
    install_nodejs
    install_ffmpeg
    install_pm2
    deploy_project
    start_service
    configure_firewall
    print_summary
}

main "$@"
