const assert = require("node:assert/strict");
const {createHash, webcrypto} = require("node:crypto");
const {readFileSync} = require("node:fs");
const path = require("node:path");
const {test} = require("node:test");
const vm = require("node:vm");
const {JSDOM} = require("jsdom");

const root = path.join(__dirname, "..");

async function createZoomablePopup(t, {innerHeight = 600, token = "test-token", notebooks = [{id: "n1", name: "Notes"}], lastError = null} = {}) {
    const dom = new JSDOM(readFileSync(path.join(root, "options.html"), "utf8"), {
        url: "https://extension.example/options.html",
        runScripts: "outside-only",
    });
    t.after(() => dom.window.close());
    const {window} = dom;
    const ip = "http://127.0.0.1:6806";
    const stored = {
        ip, token, langCode: "ru", savePathMode: "search",
        searchNotebook: "n1", searchPath: "/", searchPathLabel: "Notes/",
    };
    const local = {
        notebookListCache: {
            identity: createHash("sha256").update(`${ip}\n${token}`).digest("hex"),
            notebooks,
        },
    };
    const sentTabMessages = [];
    const fetchCalls = [];
    let closed = false;

    Object.defineProperty(window, "innerHeight", {configurable: true, writable: true, value: innerHeight});
    window.close = () => { closed = true; };
    window.console = {log() {}, warn() {}, error: console.error};
    window.TextEncoder = TextEncoder;
    Object.defineProperty(window, "crypto", {value: webcrypto});

    window.chrome = {
        storage: {
            sync: {
                async get() { return {...stored}; },
                async set(values, cb) { Object.assign(stored, values); cb?.(); },
            },
            local: {
                async get() { return local; },
                async set(values) { Object.assign(local, values); },
            },
        },
        tabs: {
            query(_q, cb) { cb([{id: 42}]); },
            sendMessage(tabId, message, cb) {
                sentTabMessages.push({tabId, message});
                window.chrome.runtime.lastError = lastError;
                cb?.();
                window.chrome.runtime.lastError = null;
            },
        },
        i18n: {getMessage: key => key, getUILanguage: () => "ru"},
        runtime: {
            lastError: null,
            getURL: value => `https://extension.example/${value}`,
        },
    };
    window.fetch = (url, options) => {
        if (url.includes("/_locales/")) {
            return Promise.resolve({
                ok: true,
                json: async () => JSON.parse(readFileSync(path.join(root, "_locales/ru/messages.json"), "utf8")),
            });
        }
        fetchCalls.push({url, body: JSON.parse(options.body)});
        return Promise.resolve({
            status: 200,
            json: async () => ({code: 0, data: {notebooks}}),
        });
    };

    for (const file of ["lib/siyuan-storage-defaults.js", "lib/siyuan-api.js", "lib/siyuan-i18n.js", "popup.js"]) {
        vm.runInContext(readFileSync(path.join(root, file), "utf8"), dom.getInternalVMContext(), {filename: file});
    }
    for (let i = 0; i < 100 && !window.document.body.classList.contains("popup-ready"); i++) {
        await new Promise(resolve => setTimeout(resolve, 1));
    }
    assert.ok(window.document.body.classList.contains("popup-ready"));
    await new Promise(resolve => setTimeout(resolve, 10));
    return {
        window,
        document: window.document,
        stored,
        sentTabMessages,
        fetchCalls,
        isClosed: () => closed,
        setInnerHeight(height) {
            window.innerHeight = height;
            window.dispatchEvent(new window.Event("resize"));
        },
    };
}

test("popup never collapses when initial Chrome viewport is tiny (< 300px)", async t => {
    const {document} = await createZoomablePopup(t, {innerHeight: 120});
    assert.equal(document.getElementById("mainContainer").style.maxHeight, "");
});

for (const [zoomLabel, height, expectedMaxHeight] of [
    ["100% zoom (600px)", 600, ""],
    ["100% zoom exact (520px)", 520, ""],
    ["125% zoom (480px)", 480, "480px"],
    ["150% zoom (400px)", 400, "400px"],
    ["175% zoom (342px)", 342, "342px"],
]) {
    test(`popup adapts maxHeight safely at ${zoomLabel}`, async t => {
        const popup = await createZoomablePopup(t, {innerHeight: 100});
        const rootEl = popup.document.getElementById("mainContainer");
        assert.equal(rootEl.style.maxHeight, "");
        popup.setInnerHeight(height);
        assert.equal(rootEl.style.maxHeight, expectedMaxHeight);
    });
}

test("popup captureMode sends send-selection for selection mode and siyuanGetReadability for others", async t => {
    const popup = await createZoomablePopup(t);
    const modeSelect = popup.document.getElementById("captureMode");
    const sendBtn = popup.document.getElementById("send");

    modeSelect.value = "selection";
    modeSelect.dispatchEvent(new popup.window.Event("change"));
    assert.equal(popup.stored.captureMode, "selection");

    sendBtn.click();
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.deepEqual(JSON.parse(JSON.stringify(popup.sentTabMessages[0])), {tabId: 42, message: {func: "send-selection", tabId: 42}});

    sendBtn.disabled = false;
    modeSelect.value = "conversation";
    modeSelect.dispatchEvent(new popup.window.Event("change"));
    sendBtn.click();
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.deepEqual(JSON.parse(JSON.stringify(popup.sentTabMessages[1])), {
        tabId: 42,
        message: {func: "siyuanGetReadability", tabId: 42, mode: "conversation"},
    });
});

test("popup send and pickElement show tip_first_time when tab cannot receive messages", async t => {
    const popup = await createZoomablePopup(t, {lastError: {message: "Receiving end does not exist."}});
    const sendBtn = popup.document.getElementById("send");
    const alertEl = popup.document.getElementById("popupAlert");

    sendBtn.click();
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(alertEl.hidden, false);
    assert.match(alertEl.textContent, /обновите страницу/i);
    assert.equal(sendBtn.disabled, false);
    assert.equal(popup.isClosed(), false);
});

test("popup pickElement closes popup on successful message delivery", async t => {
    const popup = await createZoomablePopup(t);
    popup.document.getElementById("pickElement").click();
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.deepEqual(JSON.parse(JSON.stringify(popup.sentTabMessages[0])), {tabId: 42, message: {func: "siyuanPickElement", tabId: 42}});
    assert.equal(popup.isClosed(), true);
});

test("popup expAutoScroll toggle persists to chrome.storage.sync", async t => {
    const popup = await createZoomablePopup(t);
    const toggle = popup.document.getElementById("expAutoScroll");
    assert.ok(toggle);
    assert.equal(toggle.checked, false);
    toggle.checked = true;
    toggle.dispatchEvent(new popup.window.Event("change"));
    assert.equal(popup.stored.expAutoScroll, true);
});
