const assert = require("node:assert/strict");
const {readFileSync} = require("node:fs");
const path = require("node:path");
const {test} = require("node:test");
const {JSDOM} = require("jsdom");

function createDOM(html) {
    const dom = new JSDOM(html, {url: "https://panaxgames.com/profile/example"});
    dom.window.eval(readFileSync(path.join(__dirname, "../lib/siyuan-clip-normalizer.js"), "utf8"));
    return dom;
}

test("converts nested DIV feed text blocks into separate paragraphs without merging them", t => {
    const dom = createDOM('<main><div class="feed-card"><div class="post-title">Review title</div><div class="post-meta"><a href="/profile/a">Author</a> · Score: 10/10</div><div class="post-body">First paragraph</div><div class="post-body">Second paragraph</div></div></main>');
    t.after(() => dom.window.close());
    const {document} = dom.window;
    dom.window.siyuanNormalizeClipBlockStructure(document.querySelector("main"));
    const paragraphs = Array.from(document.querySelectorAll("p"), node => node.textContent.trim());
    assert.deepEqual(paragraphs, ["Review title", "Author · Score: 10/10", "First paragraph", "Second paragraph"]);
    assert.equal(document.querySelectorAll("p p").length, 0);
});

test("wraps mixed inline runs around existing semantic blocks", t => {
    const dom = createDOM('<article><div class="mixed">Intro <strong>bold</strong><p>Keep this paragraph</p>Outro <a href="/game">game link</a></div></article>');
    t.after(() => dom.window.close());
    const {document} = dom.window;
    dom.window.siyuanNormalizeClipBlockStructure(document.querySelector("article"));
    const paragraphs = Array.from(document.querySelectorAll("p"), node => node.textContent.trim());
    assert.deepEqual(paragraphs, ["Intro bold", "Keep this paragraph", "Outro game link"]);
});

test("converts bare direct image URLs to embedded image elements", t => {
    const dom = createDOM('<div class="review">Photo: https://cdn.example.com/image/medium/photo.webp — caption</div>');
    t.after(() => dom.window.close());
    const {document} = dom.window;
    dom.window.siyuanConvertBareClipImageURLs(document.querySelector("div"));
    const image = document.querySelector("img");
    assert.equal(image?.src, "https://cdn.example.com/image/medium/photo.webp");
    assert.equal(image?.alt, "Image attachment");
    assert.equal(image?.parentElement?.tagName, "A");
    assert.match(document.querySelector("div").textContent, /Photo:/);
    assert.match(document.querySelector("div").textContent, /caption/);
});

test("does not convert image URLs already inside links or code", t => {
    const dom = createDOM('<div><a href="https://cdn.example.com/photo.png">https://cdn.example.com/photo.png</a><code>https://cdn.example.com/code.png</code></div>');
    t.after(() => dom.window.close());
    const {document} = dom.window;
    dom.window.siyuanConvertBareClipImageURLs(document.querySelector("div"));
    assert.equal(document.querySelectorAll("img").length, 0);
});
