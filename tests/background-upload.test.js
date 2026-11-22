const assert = require("node:assert/strict");
const {readFileSync} = require("node:fs");
const path = require("node:path");
const {test} = require("node:test");
const vm = require("node:vm");
const {webcrypto} = require("node:crypto");

const root = path.join(__dirname, "..");
const bgSource = readFileSync(path.join(root, "background.js"), "utf8");

function createBackgroundHarness({fetchImpl} = {}) {
    const menuItems = [];
    const tabMessages = [];
    let onInstalledCb = null;
    let onMenuClickedCb = null;
    let onCommandCb = null;
    let onMessageCb = null;

    const context = vm.createContext({
        console: {log() {}, warn() {}, error() {}},
        crypto: webcrypto,
        Blob,
        FormData,
        URL,
        unescape,
        chrome: {
            i18n: {getMessage: key => `i18n:${key}`},
            contextMenus: {
                removeAll(cb) { menuItems.length = 0; cb?.(); },
                create(item) { menuItems.push(item); },
                onClicked: {addListener(cb) { onMenuClickedCb = cb; }},
            },
            commands: {
                onCommand: {addListener(cb) { onCommandCb = cb; }},
            },
            tabs: {
                query(_q, cb) { cb([{id: 99}]); },
                sendMessage(tabId, message, cb) {
                    tabMessages.push({tabId, message});
                    cb?.();
                },
                create() {},
            },
            storage: {
                sync: {
                    get(defaults, cb) { cb({...defaults, clipTemplate: "${content}"}); },
                },
            },
            runtime: {
                lastError: null,
                onInstalled: {addListener(cb) { onInstalledCb = cb; }},
                onMessage: {addListener(cb) { onMessageCb = cb; }},
            },
        },
        fetch: fetchImpl || (async () => ({status: 200, redirected: false, json: async () => ({code: 0, msg: "", data: {md: "ok"}})})),
    });
    context.importScripts = (...files) => files.forEach(file => vm.runInContext(readFileSync(path.join(root, file), "utf8"), context));
    vm.runInContext(bgSource, context);
    return {
        context,
        menuItems,
        tabMessages,
        triggerInstalled: () => onInstalledCb?.(),
        triggerMenuClick: (info, tab) => onMenuClickedCb?.(info, tab),
        triggerCommand: cmd => onCommandCb?.(cmd),
        triggerMessage: (req, sender = {}) => new Promise(resolve => {
            const ret = onMessageCb?.(req, sender, resolve);
            if (ret !== true) resolve(undefined);
        }),
    };
}

test("getUploadFilename enforces extension matching MIME type so GIFs never become JPGs", () => {
    const {context} = createBackgroundHarness();
    assert.equal(context.getUploadFilename(escape("https://pic1.zhimg.com/v2-abc_b.jpg"), "image/gif"), "v2-abc_b.gif");
    assert.equal(context.getUploadFilename(escape("https://cdn.example.com/media/12345"), "image/gif"), "asset.gif");
    assert.equal(context.getUploadFilename(escape("https://cdn.example.com/anim.gif?w=400"), "image/gif"), "anim.gif");
    assert.equal(context.getUploadFilename(escape("https://cdn.example.com/pic.png"), "image/webp"), "pic.webp");
});

test("handleUploadCopy attaches typed Blob with .gif filename and sends tip_copy_ok for part clips", async () => {
    const uploadedForms = [];
    const {context, tabMessages} = createBackgroundHarness({
        fetchImpl: async (url, init) => {
            if (String(url).startsWith("data:")) {
                return {blob: async () => new Blob([new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61])], {type: "application/octet-stream"})};
            }
            uploadedForms.push({url, body: init.body});
            return {status: 200, redirected: false, json: async () => ({code: 0, msg: "", data: {md: "![](anim.gif)"}})};
        },
    });

    await context.handleUploadCopy({
        api: "http://127.0.0.1:6806",
        token: "tok",
        tabId: 5,
        dom: '<img src="https://cdn.example.com/anim">',
        files: {[escape("https://cdn.example.com/anim")]: {type: "image/gif", data: "data:image/gif;base64,R0lGODlh"}},
        notebook: "nb",
        href: "https://example.com/",
        tags: "",
        type: "part",
        assets: true,
        tip: true,
        fetchFileErr: false,
    });

    assert.equal(uploadedForms.length, 1);
    const uploadedFile = uploadedForms[0].body.get(escape("https://cdn.example.com/anim"));
    assert.equal(uploadedFile.type, "image/gif");
    assert.equal(uploadedFile.name, "asset.gif");
    assert.ok(tabMessages.some(m => m.message.func === "copy2Clipboard" && m.message.data === "![](anim.gif)"));
    assert.ok(tabMessages.some(m => m.message.func === "tipKey" && m.message.msg === "tip_copy_ok"));
});

test("handleArticleClip respects skipReload=true and does not reload the user tab", async () => {
    const {context, tabMessages} = createBackgroundHarness({
        fetchImpl: async (url) => {
            const p = new URL(url).pathname;
            if (p === "/api/notebook/getNotebookConf") {
                return {status: 200, json: async () => ({code: 0, data: {box: "nb", conf: {}}})};
            }
            return {status: 200, json: async () => ({code: 0, data: "20261122000000-abcdefg"})};
        },
    });

    await context.handleArticleClip({
        api: "http://127.0.0.1:6806", token: "tok", tabId: 8, title: "Chat", tip: true,
        notebook: "nb", parentDoc: "", savePathMode: "search", savePathTemplate: "/",
        href: "https://gemini.google.com/app", tags: "", listDocTree: false, skipReload: true,
    }, "http://127.0.0.1:6806", {md: "body", withMath: false}, false);

    assert.ok(tabMessages.some(m => m.message.msg === "tip_clip_ok"));
    assert.ok(!tabMessages.some(m => m.message.func === "reload"));
});

test("contextMenus and keyboard commands dispatch all clipping actions including send-selection", () => {
    const h = createBackgroundHarness();
    h.triggerInstalled();
    assert.ok(h.menuItems.some(i => i.id === "send-selection" && i.contexts.includes("selection")));
    assert.ok(h.menuItems.some(i => i.id === "pick-element"));

    h.triggerMenuClick({menuItemId: "send-selection", selectionText: "Hi"}, {id: 11});
    h.triggerMenuClick({menuItemId: "copy-to-siyuan", srcUrl: "https://x/a.gif", selectionText: ""}, {id: 12});
    h.triggerCommand("send-selection");
    h.triggerCommand("pick-element");

    assert.deepEqual(JSON.parse(JSON.stringify(h.tabMessages)), [
        {tabId: 11, message: {func: "send-selection", tabId: 11, selectionText: "Hi"}},
        {tabId: 12, message: {func: "copy", tabId: 12, srcUrl: "https://x/a.gif", selectionText: ""}},
        {tabId: 99, message: {func: "send-selection", tabId: 99}},
        {tabId: 99, message: {func: "siyuanPickElement", tabId: 99}},
    ]);
});

test("check-kernel message listener catches unexpected fetch errors cleanly", async () => {
    const h = createBackgroundHarness({
        fetchImpl: async () => { throw new Error("boom"); },
    });
    const res = await h.triggerMessage({
        func: "check-kernel",
        data: {ip: "http://127.0.0.1:6806", token: "tok", notebook: "nb", savePathTemplate: "/"},
    });
    assert.equal(res.ok, false);
    assert.equal(res.error, "tip_siyuan_kernel_unavailable");
});
