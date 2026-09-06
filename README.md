<div align="center">

# 🖥️ Visual VPS Manager

**A professional, real-operations desktop client for managing Linux VPS servers over SSH/SFTP — no command line required.**

*Every button is wired to a real SSH/SFTP operation. No mocks. No placeholders.*

[![Release](https://img.shields.io/github/v/release/AbolfazlProg/visual-vps-manager?style=flat-square)](../../releases)
[![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-blue?style=flat-square)](../../releases)
[![Tests](https://img.shields.io/badge/tests-78%20passing-brightgreen?style=flat-square)](TESTING.md)
[![License: MIT](https://img.shields.io/badge/license-MIT-yellow?style=flat-square)](LICENSE)

**[⬇ Download the latest .exe](../../releases/latest)** · [Features](#-features) · [Security](SECURITY.md) · [Build](#️-build-from-source)

</div>

---

> ⭐ **If this project helps you manage your servers, please consider giving it a star!** It takes two seconds and genuinely helps other people discover the project. Every star motivates further development — thank you! 🙏

> 🇮🇷 برای نسخه فارسی این راهنما [اینجا کلیک کنید](#-راهنمای-فارسی-persian-guide)

---

## ✨ What is Visual VPS Manager?

Visual VPS Manager turns your Linux VPS into something anyone can use — as simple as a desktop file manager, as powerful as a full terminal.

Connect with a password or SSH key, browse the **entire remote filesystem** with a beautiful file manager, edit code with syntax highlighting, run commands in a **real PTY terminal**, watch live CPU/RAM/disk/network charts, manage systemd services and processes, stream logs — all without writing a single command.

Built with **Electron + React + TypeScript** and the battle-tested [`ssh2`](https://github.com/mscdex/ssh2) library. Verified by **78 automated tests**, including integration tests against a **real in-process SSH/SFTP server** and live tests on a real Ubuntu VPS.

## 🚀 Quick Start

1. **Download** [`VisualVPSManager-Portable.exe`](../../releases/latest) (single file, no installation) — or the NSIS installer.
2. **Add your server**: IP, port (default 22), username, password *or* SSH private key.
3. **Connect** — verify the host-key fingerprint on first connect (TOFU), and you're in.

Your credentials are encrypted with the **operating system's secure store** (Windows DPAPI / macOS Keychain / Linux libsecret) — never written to disk in plain text.

## 📦 Features

| Area | What you get |
|---|---|
| 🔗 **Connection Manager** | Add/edit/duplicate/delete profiles · password & SSH key auth (+passphrase, keyboard-interactive) · test connection · per-server status (🟢🟡🔴) |
| 🔐 **Security** | OS-encrypted credential vault · **host-key pinning (TOFU)** with SHA256 fingerprints and change warnings · sudo kept memory-only, fed via stdin · strict command escaping |
| 📂 **File Manager** | Full POSIX listing with owner/group/permissions · symlinks (with broken-link detection) · breadcrumbs · lazy sidebar tree · remote-aware search · sorting/filtering · batch operations · drag & drop (OS files in, remote move inside) |
| 🛠️ **File Operations** | Create/rename/copy/move/duplicate · **safe delete → server-side trash with one-click undo** · permanent delete with size/count confirmation · chmod/chown UI with sudo escalation |
| 🔄 **Transfers** | Streaming 64 KiB chunks (GB files never enter RAM) · live progress, speed & ETA in a floating dock · cancel · **resume from offset** · **folder upload (recursive, parallel)** · **folder download as ZIP/TAR.GZ archive** |
| ✍️ **Code Editor** | CodeMirror 6: JS/TS/Python/PHP/HTML/CSS/JSON/YAML/Bash/SQL/Markdown/XML · atomic saves via temp+rename · permission preservation · server-side mtime conflict detection |
| ⌨️ **Real Terminal** | Genuine SSH **PTY**: interactive programs, Ctrl+C, resize, multiple tabs, exit codes, copy/paste |
| 📊 **Live Monitoring** | CPU/RAM/disk/network donut charts + sparkline history · system info (OS, kernel, uptime) · reboot/shutdown with confirmation |
| ⚙️ **Services & Processes** | systemd (SysV fallback) start/stop/restart via sudo · process list with kill (TERM/KILL) |
| 📜 **Log Viewer** | Live `journalctl -f` / `tail -F` streaming · filter, pause, clear, download |
| 🗒️ **Activity Log** | Every operation recorded locally — secrets never logged |

## 🎨 File Format Icons

80+ file extensions get dedicated colored icons — code files, archives, images, videos, audio, documents, fonts, disk images, executables, configs, logs — plus special recognition for `Dockerfile`, `.gitignore`, `LICENSE`, SSH keys, lock files and more.

## 🏗️ Build From Source

```bash
git clone https://github.com/AbolfazlProg/visual-vps-manager.git
cd visual-vps-manager
npm install
npm run build        # compile main + renderer
npm start            # launch the app
npm test             # 65 unit + integration tests
npm run dist         # build installer + portable .exe
```

Requires Node.js ≥ 20. See [TESTING.md](TESTING.md) for the full test strategy — including how the integration suite runs a **real SSH server in-process**.

## 🔒 Security First

This app handles your servers, so security is the top priority:

- Credentials encrypted with the OS key store — **never** plaintext on disk
- SSH host-key verification (TOFU) — you see and approve the fingerprint; key changes trigger a hard warning
- Command injection impossible by design: every dynamic value passes through single-quote escaping, unit-tested against hostile names like `it's a ; rm -rf ~; $(id) test`
- Path traversal blocked at the validation layer
- Dangerous operations (permanent delete, reboot) require explicit confirmation with size/count shown

Full details in [SECURITY.md](SECURITY.md).

## 🤝 Contributing

Issues and pull requests are welcome! The codebase is strict TypeScript with clear layering (`src/shared` → `src/main` → `src/preload` → `src/renderer`) and a well-tested operations core.

## ⭐ Support

If Visual VPS Manager saves you time:

- **Give the repo a star** ⭐ — it's the best way to help others find it
- Share it with a colleague who manages servers
- Report bugs or request features in [Issues](../../issues)

Thank you for the support! 💚

---

<div align="center">

# 🇮🇷 راهنمای فارسی (Persian Guide)

</div>

<div dir="rtl">

## ویژوال وی‌پی‌اس منیجر چیست؟

یک اپلیکیشن دسکتاپ **حرفه‌ای و کاملاً واقعی** برای مدیریت سرورهای لینوکسی (VPS) از طریق SSH/SFTP — بدون اینکه حتی یک دستور ترمینالی بنویسید.

هر دکمه‌ای که در برنامه می‌بینید به یک عملیات واقعی SSH/SFTP متصل است. هیچ قابلیت فیک یا نمایشی وجود ندارد و همه‌چیز با **۷۸ تست خودکار** پوشش داده شده — از جمله تست Integration با یک سرور SSH واقعی درون همین پروسه، و تست‌های Live روی یک سرور اوبونتو واقعی.

## امکانات

- **مدیریت اتصال‌ها**: افزودن/ویرایش/کپی سرورها با پسورد یا کلید SSH، تست اتصال، وضعیت لحظه‌ای هر سرور (🟢 متصل / 🔴 خطا)
- **امنیت بالا**: رمزها با قفل امن سیستم‌عامل (DPAPI در ویندوز / Keychain در مک) رمزنگاری می‌شوند — هرگز به‌صورت متنی ذخیره نمی‌شوند. تایید اثر انگشت host-key در اولین اتصال و هشدار جدی در صورت تغییر آن (جلوگیری از حمله MITM)
- **فایل منیجر کامل**: مرور کل فایل‌سیستم سرور با آیکون اختصاصی برای ۸۰+ فرمت، مسیر راهنما (breadcrumb)، درخت پوشه‌ها، جستجوی هوشمند، مرتب‌سازی، انتخاب گروهی و Drag & Drop دوطرفه
- **عملیات فایل**: ساخت/تغییرنام/کپی/انتقال/تکثیر — **حذف امن با سبد بازیافت و قابلیت Undo**، حذف دائمی با تایید حجم و تعداد، مدیریت Permissions (chmod/chown) با رابط گرافیکی
- **آپلود/دانلود**: استریم واقعی (بدون پر شدن رم) با پنل شناور پیشرفت زنده شامل سرعت و زمان باقی‌مانده، لغو، **ادامه از محل قطع**، **آپلود پوشه به‌صورت بازگشتی و موازی**، **دانلود پوشه به‌صورت ZIP/TAR.GZ**
- **ادیتور کد**: CodeMirror 6 با هایلایت سینتکس زبان‌های رایج، ذخیره اتمیک، حفظ دسترسی‌های فایل و تشخیص تداخل با نسخه سرور
- **ترمینال واقعی**: PTY واقعی SSH — برنامه‌های تعاملی، Ctrl+C، تغییر اندازه، چند تب همزمان، کپی/پیست
- **مانیتورینگ زنده**: نمودارهای دایره‌ای CPU/RAM/دیسک/شبکه + نمودار تاریخچه + مدیریت سرویس‌های systemd، پروسه‌ها و لاگ‌های زنده
- **گزارش فعالیت**: هر عملیات به‌صورت محلی ثبت می‌شود — رمزها هرگز لاگ نمی‌شوند

## نصب

از بخش [Releases](../../releases/latest) فایل `VisualVPSManager-Portable.exe` را دانلود کنید — **بدون نیاز به نصب**، فقط اجرا کنید. نسخه نصب‌کننده (Setup) هم موجود است.

## حمایت ⭐

اگر این پروژه برایتان مفید بود، لطفاً با دادن **ستاره ⭐** در گیت‌هاب حمایت کنید — این کار به دیده‌شدن پروژه توسط افراد بیشتر و توسعه بیشتر آن کمک می‌کند. ممنون! 🙏

</div>

---

<div align="center">

**MIT License** · Built with Electron, React, TypeScript and ssh2 · by [AbolfazlProg](https://github.com/AbolfazlProg)

</div>
