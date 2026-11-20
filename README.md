## SiYuan Chrome Extension

[中文](https://github.com/siyuan-note/siyuan-chrome/blob/main/README_zh_CN.md)

### 💡 Introduction

SiYuan browser extension for Chrome.

### 🛠️ Installation

* Chrome: [SiYuan - Chrome Web Store](https://chrome.google.com/webstore/detail/siyuan/hkcgjbeblifaincobbcfiffbpgoafepk)
* Edge: [SiYuan - Microsoft Edge Addons](https://microsoftedge.microsoft.com/addons/detail/siyuan/lclhdlhleinlppggbbgimbekofanbkcf)
* GitHub: [siyuan-note/siyuan-chrome](https://github.com/siyuan-note/siyuan-chrome)

### ✨ Usage

1. Install the extension, then configure the API token in the extension options (you can view the token in SiYuan Settings - About)
2. On a web page, select the content you want to clip, then choose "Copy to SiYuan" from the context menu
3. Paste in SiYuan

For whole-page clipping, select a notebook root or search for a parent document in the save location selector. On kernels that support structured document addressing, the extension saves under the selected document ID, including when an ancestor title contains `/` or the selected document has been renamed. If a saved location requires reselection, select it again in the extension. Older kernels retain the legacy save behavior; template paths use their existing rules.

### ⌨️ Keyboard Shortcuts

The extension supports the following keyboard shortcuts:

| Shortcut | Action |
|----------|--------|
| `Ctrl+Shift+C` (Windows/Linux) / `Cmd+Shift+C` (Mac) | Copy selected text to SiYuan |
| `Ctrl+Shift+S` (Windows/Linux) / `Cmd+Shift+S` (Mac) | Clip entire page to SiYuan |

Please customize these shortcuts in your browser's extension settings.

### 🔒 Privacy Policy

* All data is stored on a device fully controlled by the user
* No usage data is collected

### Development tests

Run `npm ci` and `npm test` with Node.js 18 or later. The tests cover clipping behavior and use jsdom for DOM regression cases; no running SiYuan kernel is required.

### Additional capture modes in this fork

The fork adds three optional capture workflows without changing the default article clipping behavior:

* **Select page element**: choose a specific DOM element with a live highlight. Use Arrow Up to move to its parent, Enter to capture, and Escape to cancel. Context menu: **Select page element and save**. Shortcut: Ctrl+Shift+E (customizable in browser extension shortcuts).
* **Entire page DOM**: saves the currently available DOM content rather than applying Readability article extraction. This does not automatically load infinite-scroll content that has not yet been rendered by the page.
* **Conversation**: on supported Gemini, ChatGPT, and Claude pages, exports detected user and assistant turns with role headings. If a site layout is not recognized, the extension falls back to normal article extraction.

The popup also includes a **Capture mode** selector. The default remains **Main article (Readability)**.
