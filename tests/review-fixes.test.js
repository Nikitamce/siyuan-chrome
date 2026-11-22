const assert = require("node:assert/strict");
const {readFileSync} = require("node:fs");
const path = require("node:path");
const {test} = require("node:test");
const {createContentDOM} = require("./helpers/content-dom");

const root = path.join(__dirname, "..");

test("element picker locks selection on click so mouse movement toward banner does not overwrite target", async t => {
    const html = `<main><article id="target"><p id="para">Important paragraph</p></article><aside id="sidebar">Sidebar</aside></main>`;
    const {window, document} = createContentDOM(t, html);
    await window.siyuanStartElementPicker(1);

    const para = document.getElementById("para");
    const sidebar = document.getElementById("sidebar");
    const highlight = document.getElementById("siyuan-dom-picker-highlight");
    const banner = document.getElementById("siyuan-dom-picker-banner");

    para.dispatchEvent(new window.MouseEvent("mousemove", {bubbles: true}));
    para.dispatchEvent(new window.MouseEvent("click", {bubbles: true, cancelable: true}));
    assert.equal(highlight.dataset.locked, "true");

    // Moving mouse over sidebar while locked must NOT change the locked selection.
    sidebar.dispatchEvent(new window.MouseEvent("mousemove", {bubbles: true}));
    assert.equal(highlight.dataset.locked, "true");

    // Clicking Parent button walks up to #target.
    banner.querySelector("[data-parent]").click();
    // Clicking Re-select unlocks hover mode.
    banner.querySelector("[data-reselect]").click();
    assert.equal(highlight.dataset.locked, "false");

    window.siyuanStopElementPicker();
    assert.equal(document.getElementById("siyuan-dom-picker-banner"), null);
});

test("Gemini conversation is auto-detected in default article mode and strips UI chrome", async t => {
    const html = `
      <main>
        <user-query>
          <span class="cdk-visually-hidden">You said</span>
          <div class="query-text">Explain quantum tunneling</div>
        </user-query>
        <model-response>
          <span class="cdk-visually-hidden">Gemini said</span>
          <div class="response-content"><p>Particles can pass through potential barriers.</p><message-actions><button>Copy</button></message-actions></div>
        </model-response>
      </main>`;
    const {window, messages} = createContentDOM(t, html, {url: "https://gemini.google.com/app/abc"});
    await window.clipArticle(1, "article");

    const upload = messages.find(m => m.func === "upload-copy");
    assert.ok(upload, "upload-copy message sent");
    assert.equal(upload.data.siteName, "Gemini");
    assert.match(upload.data.dom, /data-siyuan-conversation-role="user"/);
    assert.match(upload.data.dom, /data-siyuan-conversation-role="assistant"/);
    assert.match(upload.data.dom, /Explain quantum tunneling/);
    assert.match(upload.data.dom, /Particles can pass through potential barriers/);
    assert.doesNotMatch(upload.data.dom, /You said|Gemini said|message-actions/);
});

test("send-selection saves selected text directly as an article document", async t => {
    const html = `<article><p id="p1">Selected paragraph for SiYuan</p><p id="p2">Ignored text</p></article>`;
    const {window, document, messages} = createContentDOM(t, html);
    const range = document.createRange();
    range.selectNodeContents(document.getElementById("p1"));
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);

    await window.clipSelection({func: "send-selection", tabId: 7});
    const upload = messages.find(m => m.func === "upload-copy");
    assert.ok(upload);
    assert.equal(upload.data.type, "article");
    assert.match(upload.data.dom, /Selected paragraph for SiYuan/);
    assert.doesNotMatch(upload.data.dom, /Ignored text/);
});

test("copy selection supports selectionText fallback and image-only right-click", async t => {
    const {window, messages} = createContentDOM(t, "<main><p>Body</p></main>");
    await window.clipSelection({func: "copy", tabId: 3, selectionText: "Shadow DOM text"});
    const textUpload = messages.find(m => m.func === "upload-copy");
    assert.ok(textUpload);
    assert.equal(textUpload.data.type, "part");
    assert.match(textUpload.data.dom, /Shadow DOM text/);

    messages.length = 0;
    await window.clipSelection({func: "copy", tabId: 3, srcUrl: "https://cdn.example.com/anim.gif"});
    const imgUpload = messages.find(m => m.func === "upload-copy");
    assert.ok(imgUpload);
    assert.match(imgUpload.data.dom, /https:\/\/cdn\.example\.com\/anim\.gif/);
});

test("Zhihu GIF thumbnails update DOM src to .gif and magic-byte sniffing preserves image/gif", async t => {
    const html = `<article><img class="ztext-gif" src="https://pic1.zhimg.com/v2-abc_b.jpg"></article>`;
    const {window, document, messages} = createContentDOM(t, html, {url: "https://zhuanlan.zhihu.com/p/1"});
    const fetchCalls = [];
    const gifBytes = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x01, 0x00, 0x01, 0x00]);
    window.fetch = async (url, init) => {
        fetchCalls.push({url, accept: init?.headers?.accept});
        return {
            ok: true,
            headers: {get: () => "application/octet-stream"},
            blob: async () => new window.Blob([gifBytes], {type: "application/octet-stream"}),
        };
    };
    window.siyuanLoadStorageSettings = async () => ({assets: true});

    const container = document.querySelector("article");
    await window.sendUpload(container, 1, undefined, "article", {title: "GIF test"}, "https://zhuanlan.zhihu.com/p/1", {assets: true});
    const upload = messages.find(m => m.func === "upload-copy");
    assert.ok(upload);
    assert.equal(fetchCalls[0].url, "https://pic1.zhimg.com/v2-abc_b.gif");
    assert.match(fetchCalls[0].accept, /^image\/gif/);
    assert.match(upload.data.dom, /v2-abc_b\.gif/);
    const fileEntry = upload.data.files[escape("https://pic1.zhimg.com/v2-abc_b.gif")];
    assert.ok(fileEntry, "DOM src and uploaded files key match");
    assert.equal(fileEntry.type, "image/gif");
    assert.match(fileEntry.data, /^data:image\/gif;base64,/);
});

test("lazy-loaded below-the-fold images resolve data-src / data-actualsrc placeholders", async t => {
    const html = `<div><img src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==" data-actualsrc="https://cdn.example.com/real.png"></div>`;
    const {window, document, messages} = createContentDOM(t, html);
    await window.sendUpload(document.querySelector("div"), 1, undefined, "article", {title: "Lazy"}, "https://example.com/", {assets: false});
    const upload = messages.find(m => m.func === "upload-copy");
    assert.match(upload.data.dom, /https:\/\/cdn\.example\.com\/real\.png/);
});

test("Zhihu and KaTeX math formulas normalize to data-formula and code blocks + redundant spans clean up", t => {
    const html = `
      <div>
        <p><span class="ztext-math" data-tex="E = mc^2">E=mc^2</span></p>
        <p><img eeimg="1" src="https://www.zhihu.com/equation?tex=a%5E2%2Bb%5E2%3Dc%5E2" alt="a^2+b^2=c^2"></p>
        <p><span class="katex"><annotation encoding="application/x-tex">\\int_0^1 x\\,dx</annotation></span></p>
        <pre data-lang="python"><button aria-label="Copy">Copy</button><span>def f(x):</span><br><span>    return x + 1</span></pre>
        <blockquote><span>Quoted </span><span>inline text</span></blockquote>
      </div>`;
    const {window, document} = createContentDOM(t, html);
    const container = document.querySelector("div");
    window.siyuanNormalizeClipMath(container);
    window.siyuanNormalizeClipCodeBlocks(container);
    window.siyuanUnwrapRedundantSpans(container);

    const formulas = Array.from(container.querySelectorAll("[data-formula]"), el => el.getAttribute("data-formula"));
    assert.deepEqual(formulas, ["E = mc^2", "a^2+b^2=c^2", "\\int_0^1 x\\,dx"]);

    const code = container.querySelector("pre > code");
    assert.ok(code);
    assert.equal(code.className, "language-python");
    assert.equal(code.textContent, "def f(x):\n    return x + 1");
    assert.equal(container.querySelectorAll("pre button").length, 0);

    assert.equal(container.querySelectorAll("blockquote span").length, 0);
    assert.equal(container.querySelector("blockquote").textContent, "Quoted inline text");
});

test("popup.css clamps dimensions to viewport so 125%+ global zoom never clips content", () => {
    const css = readFileSync(path.join(root, "popup.css"), "utf8");
    assert.match(css, /max-height:\s*min\(var\(--popup-max-height\),\s*100vh\)/);
    assert.match(css, /width:\s*min\(var\(--popup-width\),\s*100vw\)/);
    assert.match(css, /\.popup__mode-select\s*\{/);
});
