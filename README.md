# TOEIC 词汇学习应用

本地运行的托业（TOEIC）词汇学习与复习工具。**纯前端单页应用**，无需安装、无需构建、无需联网。

## 快速开始

双击打开 `index.html` 即可在浏览器中使用（Edge / Chrome / Firefox 均可）。

> 也可以把整个文件夹放到任意位置，或放到内网服务器上多人共用。

## 功能

| 功能 | 说明 |
| --- | --- |
| 按单元浏览 | 内置 30 个单元（Unit 1–30，每单元 Part A/B 各 20 词，共 1200 词），侧栏显示每单元词汇量与掌握进度；另有「🔎 全部单元」一次浏览全部 |
| 词汇卡片 | 每张卡片同屏展示全部字段：词条、音标、词性、英文注释、中文注释、例句 + 译文（高度随内容自适应，长例句完整显示） |
| 检索 | 顶部搜索框跨全部单元检索单词 / 释义 / 例句；结果卡片带「Unit X · Part A/B」徽标，便于定位出处 |
| 生词 / 熟词标记 | 卡片上点「生词」「熟词」即可标记，再次点击取消；状态保存在浏览器本地 |
| 筛选 | 顶部「全部 / 生词 / 熟词 / 未标记」四种筛选，可与单元、检索叠加 |
| 只看生词复习 | 右上角「🔥 只看生词」进入复习模式：先只见单词，翻面自检，标记后自动下一张 |
| 朗读发音 | 词条：直接点击单词（或复习模式按 `P`）；例句：点击例句整行或其 🔊 图标整句朗读（复习模式按 `S`），另有「慢」按跟读速度朗读 |
| 美音 / 英音 | 每张卡片的词条行与例句行都有「美」「英」两个按钮，点一下只试听该口音、不改设置；默认口音在顶部「发音」里选（记住上次选择），预生成英音音频缺失时自动退回本机 en-GB 语音合成 |
| 单元连读 | 单元标题右侧「▶ 单元连读」一次读完本单元：单词美/英各一遍、例句美/英各两遍、词条之间停 3 秒，边播边高亮当前卡片并自动滚动；再点一次或按 `Esc` 停止 |
| 放大浏览 | 卡片「放大浏览」进入全屏单卡模式，可前后切换 |
| 自定义导入 | 支持导入 JSON 词库，自动合并去重，可在侧栏删除 |
| 导出备份 | 「导出」按钮下载自定义词库 + 全部标记，用于换电脑/换浏览器时迁移 |

### 复习模式快捷键

`←` / `→` 切换卡片 · `空格` 翻面 · `1` 标为生词 · `2` 标为熟词 · `P` 朗读单词 · `Shift + P` 换一种口音读单词 · `S` 朗读例句 · `Shift + S` 慢速 · `D` 连读 · `Esc` 关闭

### 单元连读

- 入口：选中某个单元后，标题右侧的「▶ 单元连读」。「全部单元」与检索结果下不提供（前者 1200 词太长，后者词集随时在变）
- 播的是当前一屏所见的词：切到「生词」筛选后就只连读生词
- 顺序：单词（默认口音 → 另一口音）→ 例句（默认口音 × 2 → 另一口音 × 2），每条之间停 3 秒；口音先后跟着顶部「发音」里的默认口音
- 全程只播 `audio/` 下已有的 4800 条预生成 mp3（同一条例句会连播两遍），**不需要重新生成音频**；某段确实没有音频（如导入的自定义词库）时，那一段改用本机合成语音，不打断整轮
- 顶部「发音」里的语速倍率与音源设置同样生效；按钮上会显示「第 N/M 词 · 例句第 2 遍」等进度，3 秒间隔期间显示倒数秒数
- 40 词的单元约 17–20 分钟；切换单元、改筛选、输入检索词或进入放大浏览都会自动停止

## 自定义词汇导入格式

点「导入 JSON」选择文件（可一次选多个），或在侧栏「下载导入模板」获得标准模板。
参考示例文件：`samples/sample-import.json`

```json
{
  "topic": "自定义词库名",
  "icon": "📝",
  "words": [
    {
      "word": "example",
      "phonetic": "/ɪɡˈzɑːmpl/",
      "pos": "n.",
      "englishDef": "an instance or specimen of something",
      "meaning": "例子，范例",
      "example": "This is a good example.",
      "exampleCn": "这是一个好例子。",
      "part": "A"
    }
  ]
}
```

字段说明：`word` 必填，其余字段可留空；`icon` 可省略（默认 📚）；`englishDef`（英文注释）、`part`（分区 A/B）为可选字段。

导入规则：

- 同名主题（不区分大小写）会自动合并，已存在的单词按拼写（忽略大小写）跳过，不会重复
- 除上面的标准格式外，还兼容：主题对象数组 `[{topic, words}]`、`{topics: [...]}`、纯词汇数组 `[{word, ...}]`、单条词汇对象 `{word, ...}`
- 导入「本应用导出的备份文件」（含 `customTopics` / `marks` 字段）时，会同时恢复自定义词库和标记进度

## 数据存储位置

所有进度存在浏览器 `localStorage` 的 `toeic-vocab-app-v1` 键下（生词/熟词标记、导入的词库、界面偏好），不会上传到任何服务器。

- 标记键格式：`单元ID::小写单词`（如 `unit-3::bonus`），因此升级词库后进度依然有效
- 无痕/隐私模式下关闭标签页后数据会丢失；浏览器设置里「退出时清除网站数据」也会导致进度被清空
- 若浏览器禁用了 localStorage，应用仍可正常使用，但会提示「本次标记不会被保存」，请及时「导出」备份

## 安装到手机（PWA）

应用本身不用改任何东西，装到手机桌面靠的是 PWA：部署到一个 **HTTPS** 地址 → 手机 Chrome 打开 → 「安装」。
装好后有独立图标、无地址栏全屏显示，**断网也能背单词、听发音**。

### 1. 先部署到任意静态托管

离线缓存与安装都要求安全上下文（HTTPS，或 `localhost`）；`file://` 直接打开与局域网 `http://192.168.x.x` 都**不能**安装。

| 方式 | 命令 / 操作 | 说明 |
| --- | --- | --- |
| GitHub Pages | `git init && git add . && git commit -m "toeic pwa"` → 建仓库 → `git remote add origin … && git push -u origin main` → Settings → Pages → Deploy from branch（`main` / 根目录） | 仓库约 120MB / 4800 个文件，在限制内但首次 push 较慢；已放 `.nojekyll` 跳过 Jekyll 构建 |
| Cloudflare Pages | `npx wrangler pages deploy . --project-name toeic`（Direct Upload，本地文件直传） | 不绕 Git，上传 106MB 音频最快 |
| Vercel | `npx vercel --prod` | 与上面两者同样可用 |

子路径部署（如 `https://<user>.github.io/toeic/`）也已适配：`manifest.webmanifest` 里 `start_url` / `scope` 都是 `./`，Service Worker 按自身位置解析音频前缀。

### 2. 手机上安装

1. 用 **Chrome**（或 Edge）打开部署地址
2. 页面顶部会出现「**📲 安装到桌面**」按钮，点它；没出现就用浏览器菜单 → 「安装应用」/「添加到主屏幕」
3. 之后从桌面图标打开：无地址栏、全屏，就是一个 App

> 进度存在该 HTTPS 源对应的 `localStorage` 里。**换个托管域名打开会看不到旧进度**，迁移前先用「导出」备份。

### 3. 离线策略（音频共 105MB / 4800 条，不能一次预下载）

- **应用壳**（HTML/CSS/JS/图标，不到 1MB）：安装时全量预缓存，断网首次打开也没问题
- **发音 mp3**：听一条存一条（cache-first），越用越离线；想一次全存进手机：
  「**🔊 发音 → 离线音频 → 全部缓存到本地**」（约 105MB，WiFi 下几分钟，可中途取消，不影响已存部分）
  同一排还有「清除缓存」，只清发音，不动生词标记
- 首次安装会顺带向系统申请**持久化存储**，避免手机空间吃紧时 Chrome 把缓存清掉
- 断网时碰到还没缓存的词，只那一个词改用本机合成语音，其余词照常播预生成音频（不会一个失败就整轮降级）

### 4. 改了词库/代码后怎么更新到手机

递增 `sw.js` 顶部的 `CACHE_VERSION`（当前 `toeic-v3`）并重新部署。手机下次打开时，新 Service Worker 会停在 waiting，
页面顶部出现「**↻ 更新**」，点一下才切换新版（不会在背单词背到一半时强行刷新）。

> 内容改动与版本号递增要放在**同一次上传**里：新 SW 是在 install 那一刻预缓存应用壳的，
> 先升版后改文件会让用户多开一次才能拿到新 JS。音频缓存 `toeic-audio` 不带版本号，升版不会掉。

### 5. 常见问题

- **没有「安装到桌面」按钮？** 三查：① 地址是否 HTTPS；② 是否已装过（已装则不再提示，Chrome 菜单里仍可能有）；③ Chrome 菜单里有没有「安装应用」。实在没有就「添加到主屏幕」，离线缓存依然生效
- **能不能把文件夹拷到手机上用 `file://` 打开？** 不建议：4800 个文件解压极慢，且 Chrome 在 `file://` 下 `localStorage` 常不可用（标记会静默丢失）、也无法注册 Service Worker
- **iPhone 能用吗？** 能，Safari 分享菜单 → 「添加到主屏幕」；但 iOS 对 PWA 存储的回收比 Android 激进，长期不用可能要重新缓存音频
- **想装成真正的 APK？** 用 Capacitor 把 `index.html` + `css/` + `js/` + `audio/` 拷进 `android/app/src/main/assets/public/` 即可（注意别让 `docs/`、`tools/` 跟着进去）。当前这套 PWA 代码不需要修改就能在那儿跑

## 文件结构

```
toeic/
├── index.html              # 主页面
├── manifest.webmanifest    # PWA 清单（名称 / 图标 / standalone / 作用域）
├── sw.js                   # Service Worker：壳预缓存 + 音频 cache-first + 离线兜底
├── icons/                  # 应用图标（由 tools/make-icons.ps1 从 docs/icon-source.png 生成）
├── .nojekyll               # 告诉 GitHub Pages 不要走 Jekyll 构建
├── css/style.css           # 样式（浅色简洁、响应式、含 standalone 安全区适配）
├── js/pwa.js               # SW 注册、安装入口、版本更新、离线音频批量缓存
├── js/data.js              # 内置词汇数据（30 单元 / 1200 词，由 tools/build-from-md.mjs 生成）
├── js/tts.js               # 发音引擎（预生成音频 → 神经语音 → 系统默认；美音 / 英音双轨）
├── js/audio-manifest.js    # 预生成音频清单（由 tools/gen-audio.mjs 生成）
├── audio/                  # 预生成发音 mp3（__w-us / __e-us 美音，__w-gb / __e-gb 英音）
├── js/storage.js           # localStorage 封装（标记、自定义词库、偏好）
├── js/app.js               # 主逻辑（单元切换、检索、筛选、复习、导入导出）
├── tools/build-from-md.mjs # 词库生成脚本：docs/托业词汇词库.md → js/data.js
├── samples/                # 导入示例 JSON
└── docs/                   # 词库源 markdown（托业词汇词库.md）与实现计划
```

## 扩展 / 修改内置词库

内置词库的**唯一真源**是 `docs/托业词汇词库.md`（Markdown 表格）。改词请编辑该文件，然后重新生成：

```powershell
node tools/build-from-md.mjs
```

不要直接改 `js/data.js`（它是生成产物，重跑脚本会被覆盖）。
单元 `id`（`unit-1`…`unit-30`）由单元号决定，保持稳定即可保证已有标记不丢。

## 内置词库的数据来源

`js/data.js` 由 `tools/build-from-md.mjs` 从 `docs/托业词汇词库.md` 生成。
该 markdown 整理自《新托业词汇本领书（第 3 版）》，按 Unit / Part A / Part B 组织，
字段为：词条 / 音标 / 词性 / 英文注释 / 中文注释 / 例句 / 例句译文。

生成脚本会做轻量清洗：英文字段全角标点转半角、收敛多余空格；中文字段去掉汉字/全角标点之间的空格。

> 说明：`tools/build-data.mjs`（旧版，基于 HuggingFace 数据集 + ECDICT）已不再用于当前词库；
> 运行它会**覆盖**现有 data.js，请勿误跑。

重建词库（需 Node 18+）：

```powershell
node tools/build-from-md.mjs [--md docs/托业词汇词库.md] [--out js/data.js]
```

## 生成美音 / 英音发音音频（可选）

不跑这一步应用也能用：没有 mp3 时朗读会退回浏览器合成语音。跑一次后发音不再依赖本机装了什么语音。

```powershell
py -m pip install edge-tts                                  # 一次性，需联网
node tools/gen-audio.mjs --unit 1 --accent gb               # 先给某个单元补英音，试听确认音色
node tools/gen-audio.mjs                                    # 全量（美音 en-US-AriaNeural + 英音 en-GB-RyanNeural）
node tools/gen-audio.mjs --accent us --voice-us en-US-AvaMultilingualNeural   # 换美音音色
node tools/gen-audio.mjs --proxy http://127.0.0.1:7897      # 需要走本地代理时
```

- 已存在的 mp3 一律跳过，所以可以分单元、分口音多次增量跑，中断后重跑只补差集
- 产物：`audio/<单元>__<词条>__<hash>__{w,e}-{us,gb}.mp3` + 清单 `js/audio-manifest.js`（形状 `{ us: {w,e}, gb: {w,e} }`）
- 改词库后重跑一次本脚本，新词条才会有音频（老词条的 mp3 按文件名定位，不会重复合成）
- 只在命令行里改过 `--voice` 类参数不影响运行时；`js/audio-manifest.js` 是生成产物，勿手工编辑

## 更换应用图标

```powershell
pwsh -File tools/make-icons.ps1 -Source docs/icon-source.png
```

母图（`docs/icon-source.png`）四周允许有留白 / 圆角 / 水印：脚本会沿中线定位色块边界、内收 5% 裁成正方形，
再输出 `icons/icon-192.png`、`icon-512.png`、`icon-maskable-512.png`、`apple-touch-icon.png`。
换图后记得递增 `sw.js` 的 `CACHE_VERSION`（图标在应用壳预缓存清单里）。加 `-WhatIf` 只看检测结果不写文件。

## 常见问题

- **发音没有声音？** 需要系统已安装英语语音包（Windows：设置 → 时间和语言 → 语音 → 添加语音，选 English），或按上面「生成美音 / 英音发音音频」预生成 mp3。
- **选了英音却没听到英音？** 三点检查：① 该单元是否已跑过 `--accent gb`（未生成则走合成语音）；② 本机有没有 en-GB 语音（Edge 自带较多，Chrome 常只有美音）；③「发音」里音源是否被锁成「仅预生成音频」。
- **手机上能用吗？** 布局已适配平板与手机（侧栏变为横向滑动）。想装到桌面离线用，见上面「安装到手机（PWA）」。
- **想清空全部标记重新开始？** 侧栏底部「清空所有标记」（不会删除导入的自定义主题）。
