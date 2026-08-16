# Freezy

冻结网页当前的 hover / active 状态，方便截下拉导航、hover 卡片这类只在鼠标停留时才存在的 UI。

不内置截图——锁住状态后用你自己的截图工具就行。

## 安装

1. Chrome 打开 `chrome://extensions`
2. 右上角开「开发者模式」
3. 「加载已解压的扩展程序」，选这个目录

## 用法

| 操作 | 结果 |
| --- | --- |
| `⌥⇧F`（Option+Shift+F） | 冻结 / 解冻当前 hover 状态 |
| `Esc` | 解冻 |
| 点工具栏图标 | 同快捷键（页面抢走键盘时的备用入口） |

hover 出目标状态 → 按快捷键 → 鼠标随便移动 → 截图 → `Esc`。

改快捷键：`chrome://extensions/shortcuts`。

**快捷键必须左手单独按得下来** —— 按下的那一刻右手正按着鼠标不能动，那是整个工具成立的前提。`⌥⇧F` 的修饰键和 F 都在左手区；换成 K、L 这类右手位的键会逼你去动那只必须保持不动的手。以后调键位先过这一条。

## 冻结时的三层反馈

三个信号分工不同，因为它们跟「不能入镜」这条约束的关系不一样：

| 信号 | 时长 | 为什么这样设计 |
| --- | --- | --- |
| 右下角 toast | 3 秒 | 醒目地告诉你已冻结，然后主动退场。带倒计时和排空进度条，让「它要走了」是被预告的，不是突然消失 |
| 提示音 | 0.5s / 0.08s | 冻结是低频落定 + 冰晶余响，解除是一小口高频气声。声音是唯一不可能进截图的通道，所以状态反馈放这里最合适 |
| 工具栏图标蓝点 | 全程 | 浏览器 chrome，永远不入镜，所以可以一直亮着 |

toast 的文案是 `Notice hides in 3s`，明确说会消失的是**提示**、不是冻结状态。光写一个 3…2…1 然后消失，会被读成「冻结到期了」，接着页面点不动就显得像坏了。

**冻结不会自动到期**，只能靠 `Esc` 或点工具栏图标解除。截图截到一半状态自己塌掉是不可接受的。

两个提示音是**刻意不对称**的，不是互为镜像：冻结 0.5 秒、低频、两层；解除 0.08 秒、高频、单层。只靠音高高低区分的两个音，在低音量、注意力全在页面上的时候其实分不出来——同时拉开时长、音区、音色和层数，才能不用看就知道当前是哪个状态。

提示音是纯增强：某些站点的自动播放策略可能挡住它，那样会静默跳过，toast 照常工作，不会报错。

## 它怎么工作

两条路同时走，缺一条都会漏掉一大类页面：

**1. 吞事件** —— 捕获阶段拦掉 `mousemove / mouseout / mouseleave / pointerout` 等，页面以为鼠标没动过，React 状态驱动的菜单不会收。焦点事件（`blur` / `focusout` / `visibilitychange`）也一起拦，因为 macOS 截图快捷键会让浏览器窗口失焦，有些菜单靠这个关自己。

content script 跑在 `document_start`，这样我们的监听器先于页面注册——`stopImmediatePropagation` 只能挡住比自己晚注册的监听器，晚一步就没用了。

**2. 改写 CSS** —— 把所有含 `:hover` / `:active` 的规则改写成 class 版本（`.__freezy-hover`），贴到 `querySelectorAll(':hover')` 返回的整条元素链上。

浏览器的原生 `:hover` 是跟着真实鼠标位置走的，拦 JS 事件影响不了它，所以第 1 条救不了纯 CSS 的效果，必须有第 2 条。

能这样改写是因为特异性正好相等：`:hover` 和单个 class 都是 `(0,1,0)`，`.btn:hover` 和 `.btn.__freezy-hover` 权重完全一样，不需要 `!important`。

顺序上先翻 flag、先打标（同步），再处理样式表（可能要联网）。所以就算样式表慢，菜单在第一时间就已经保住了。

## 已验证

在 stripe.com 上实测：

- `querySelectorAll(':hover')` 正确返回 11 层 hover 链
- 6 个样式表**全部跨域不可读**，直读收集到 0 条规则；经 fetch 回退救回 89 条
- 250 个 a / button 中 20 个响应改写后的 CSS，值正确（`Start now` 背景 `rgb(83,58,253)` → `rgb(64,50,200)`，`Contact sales` color + borderColor 同步变）
- 合成 `blur` / `visibilitychange` / `focusout` 没能关掉 Stripe 的菜单——失焦风险在这个站上没复现，但合成事件不等于真实失焦，拦截器保留

## 已知限制

- **延迟关闭**：菜单如果用 `setTimeout` 延迟收起、且计时器在冻结前已启动，吞事件拦不住。
- **`@layer`**：改写后的规则不再包在原 layer 里，优先级会被抬高。冻结场景下通常无害。
- **closed shadow root**：拿不到，只能靠吞事件兜底。
- **真实失焦**：只用合成事件验证过，真机按 `Cmd+Shift+4` 的行为还没实测。
- **提示音**：自动播放策略在 stripe.com 上验证可以发声（页面无用户手势时 AudioContext 仍为 `running`），但该策略跟站点 Media Engagement Index 有关，冷门站点未必一样。播不出来会静默跳过。
- **canvas / WebGL**：画在 canvas 里的 hover 效果不归 CSS 管，这套机制无效。

## 结构

```
manifest.json      MV3
src/content.js     冻结机制（吞事件 + CSS 改写）
src/background.js  快捷键路由 + 跨域 CSS 代取
icons/             16 / 32 / 48 / 128
```

图标是冰蓝渐变底 + 白色光标箭头，配色沿用徽章的 `#6ec8ff`。16 / 32 用加粗尾巴并做轮廓膨胀，48 / 128 用精细形状并带一颗 sparkle——细箭头在 16px 下会被抗锯齿糊掉，小尺寸必须换一版更实的形状。

跨域 CSS 必须由 service worker 取：content script 的 `fetch` 带的是页面 origin，受 CORS 约束，CDN 不发 `Access-Control-Allow-Origin` 就会静默拿不到。service worker 走扩展自己的 origin，用 `host_permissions` 而不是 CORS。
