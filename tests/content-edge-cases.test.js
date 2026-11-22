const assert = require("node:assert/strict");
const {readFileSync} = require("node:fs");
const path = require("node:path");
const {test} = require("node:test");
const vm = require("node:vm");
const {createContentDOM} = require("./helpers/content-dom");

const root = path.join(__dirname, "..");

test("element picker end-to-end: click locks, ArrowUp walks to parent, Enter clips and cleans up", async t => {
    const html = `<main><section id="card"><h2 id="title">Post</h2><p id="body">Details</p></section><footer id="foot">Footer</footer></main>`;
    const {window, document, messages} = createContentDOM(t, html);
    await window.siyuanStartElementPicker(5);

    const body = document.getElementById("body");
    const foot = document.getElementById("foot");
    body.dispatchEvent(new window.MouseEvent("mousemove", {bubbles: true}));
    body.dispatchEvent(new window.MouseEvent("click", {bubbles: true, cancelable: true}));
    // Hovering footer while locked must not steal selection.
    foot.dispatchEvent(new window.MouseEvent("mousemove", {bubbles: true}));
    // ArrowUp moves selection from #body to #card.
    document.dispatchEvent(new window.KeyboardEvent("keydown", {key: "ArrowUp", bubbles: true, cancelable: true}));
    // Enter triggers capture.
    document.dispatchEvent(new window.KeyboardEvent("keydown", {key: "Enter", bubbles: true, cancelable: true}));
    await new Promise(resolve => setTimeout(resolve, 20));

    const upload = messages.find(m => m.func === "upload-copy");
    assert.ok(upload, "captured locked parent container");
    assert.equal(upload.data.skipReload, true);
    assert.match(upload.data.dom, /Post/);
    assert.match(upload.data.dom, /Details/);
    assert.doesNotMatch(upload.data.dom, /Footer/);
    assert.equal(document.getElementById("siyuan-dom-picker-banner"), null);
    assert.equal(document.getElementById("siyuan-dom-picker-highlight"), null);
});

test("media elements (audio, video, iframe) are preserved during block structure normalization", t => {
    const html = `
      <main>
        <div class="media-card">
          <div class="audio-wrap"><audio controls src="https://cdn.example.com/clip.mp3"></audio></div>
          <div class="video-wrap"><video controls src="https://cdn.example.com/demo.mp4"></video></div>
          <div class="embed-wrap"><iframe src="https://example.com/embed"></iframe></div>
          <div class="empty-wrap">   </div>
        </div>
      </main>`;
    const {window, document} = createContentDOM(t, html);
    const main = document.querySelector("main");
    window.siyuanNormalizeClipBlockStructure(main);

    assert.equal(main.querySelectorAll("audio").length, 1);
    assert.equal(main.querySelectorAll("video").length, 1);
    assert.equal(main.querySelectorAll("iframe").length, 1);
    assert.equal(main.querySelectorAll(".empty-wrap").length, 0);
});

test("magic-byte MIME sniffing identifies GIF87a, GIF89a, WebP, PNG and JPEG regardless of server header", async t => {
    const {window} = createContentDOM(t, "<p>test</p>");
    const samples = [
        ["image/gif", [0x47, 0x49, 0x46, 0x38, 0x37, 0x61]],
        ["image/gif", [0x47, 0x49, 0x46, 0x38, 0x39, 0x61]],
        ["image/webp", [0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]],
        ["image/png", [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]],
        ["image/jpeg", [0xff, 0xd8, 0xff, 0xe0]],
    ];
    for (const [expected, bytes] of samples) {
        const blob = new window.Blob([new Uint8Array(bytes)], {type: "application/octet-stream"});
        const detected = await window.detectImageMime(blob, "application/octet-stream");
        assert.equal(detected, expected);
    }
});

test("siyuanSvgToImg converts regular SVGs to img but protects SVGs inside math formulas", async t => {
    const html = `
      <div id="root">
        <svg id="chart" width="10" height="10"><rect width="10" height="10"/></svg>
        <span class="ztext-math" data-tex="x^2"><svg id="math-svg"><path d="M0 0"/></svg></span>
        <span class="katex"><svg id="katex-svg"><path d="M0 0"/></svg></span>
      </div>`;
    const {window, document} = createContentDOM(t, html);
    await window.siyuanSvgToImg(document.getElementById("root"));

    assert.equal(document.getElementById("chart"), null, "regular SVG converted to img");
    assert.equal(document.querySelectorAll("#root > img").length, 1);
    assert.ok(document.getElementById("math-svg"), "Zhihu math SVG preserved");
    assert.ok(document.getElementById("katex-svg"), "KaTeX SVG preserved");
});

test("siyuanResolveClipLinks resolves relative URLs while leaving anchors and non-HTTP schemes untouched", t => {
    const html = `
      <div>
        <a id="rel" href="/game-detail/116486">Game</a>
        <a id="hash" href="#section-2">Jump</a>
        <a id="mail" href="mailto:test@example.com">Mail</a>
        <a id="js" href="javascript:void(0)">JS</a>
      </div>`;
    const {window, document} = createContentDOM(t, html);
    const div = document.querySelector("div");
    window.siyuanResolveClipLinks(div, "https://panaxgames.com/notification");

    assert.equal(document.getElementById("rel").getAttribute("href"), "https://panaxgames.com/game-detail/116486");
    assert.equal(document.getElementById("hash").getAttribute("href"), "#section-2");
    assert.equal(document.getElementById("mail").getAttribute("href"), "mailto:test@example.com");
    assert.equal(document.getElementById("js").getAttribute("href"), "javascript:void(0)");
});

test("siyuanUnwrapRedundantSpans removes theme color spans but keeps bold/italic/underline/id/formula", t => {
    const html = `
      <p>
        <span style="color: rgb(170, 170, 170);">plain gray</span>
        <span style="font-weight: 700;">keep bold</span>
        <span style="font-style: italic;">keep italic</span>
        <span style="text-decoration: underline;">keep underline</span>
        <span id="anchor">keep id</span>
        <span data-formula="x+y">x+y</span>
      </p>`;
    const {window, document} = createContentDOM(t, html);
    const p = document.querySelector("p");
    window.siyuanUnwrapRedundantSpans(p);

    assert.equal(p.querySelectorAll("span").length, 5);
    assert.doesNotMatch(p.innerHTML, /rgb\(170/);
    assert.match(p.textContent, /plain gray/);
});

test("mathjax.js does not schedule infinite polling timers on pages without MathJax", () => {
    let timerCalls = 0;
    const ctx = vm.createContext({
        window: {},
        document: {
            body: {},
            querySelector: () => null,
        },
        console: {error() {}},
        setTimeout: () => { timerCalls++; },
    });
    vm.runInContext(readFileSync(path.join(root, "lib/mathjax.js"), "utf8"), ctx);
    assert.equal(timerCalls, 0);
});
