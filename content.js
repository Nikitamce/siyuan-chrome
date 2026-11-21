let siyuanLangReady = siyuanInitLanguageFromStorage();

chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "sync" && changes.langCode) {
        siyuanLangReady = siyuanLoadLanguageFile(changes.langCode.newValue);
    }
});

const eventDispatcher = async (request, sender, sendResponse) => {
    if ("tip" === request.func && request.tip) {
        siyuanShowTip(request.msg, undefined, request.timeout);
        return;
    }

    if ("tipKey" === request.func && request.tip) {
        void siyuanShowTipByKey(request.msg, request.timeout,
            message => request.documentID ? `${message} [${request.documentID}]` : message);
        return;
    }

    if ("copy2Clipboard" === request.func) {
        await copyToClipboard(request.data);
        return;
    }

    if ("reload" === request.func) {
        window.location.reload();
        return;
    }

    if ("siyuanPickElement" === request.func) {
        siyuanStartElementPicker(request.tabId);
        return;
    }

    if ("siyuanGetReadability" === request.func) {
        siyuanGetReadability(request.tabId, request.mode);
        return;
    }

    if ("copy" !== request.func) {
        return;
    }

    const clipSettings = await siyuanEnsureClipReady();
    if (!clipSettings) {
        return;
    }

    const selection = window.getSelection();
    if (selection && 0 < selection.rangeCount) {
        const range = selection.getRangeAt(0);
        const tempElement = document.createElement("div");
        tempElement.appendChild(range.cloneContents());
        const sourceImages = Array.from(document.querySelectorAll("img")).filter(image => range.intersectsNode(image));
        siyuanNormalizePictureImages(tempElement, document.baseURI, sourceImages);
        siyuanCleanZhihu(tempElement, document.URL);
        siyuanSendUpload(tempElement, request.tabId, request.srcUrl, "part", undefined, undefined, clipSettings);
    } else {
        void siyuanShowTipByKey("tip_no_selection", 3000);
    }
};

document.addEventListener("DOMContentLoaded", function () {
    chrome.runtime.onMessage.removeListener(eventDispatcher);
    chrome.runtime.onMessage.addListener(eventDispatcher);
});

/**
 * 页面顶部提示（#siyuanmessage）状态机。
 *
 * 模式（{@link TIP_BEHAVIOR}）：
 * - progress：保持显示，直到下一个状态替换
 * - transient：超时后自动隐藏（默认 5000 ms）
 *
 * 动画：首次弹出 / 收起时有 transition；progress 状态下仅更新 innerHTML，保持连贯。
 *
 * 剪藏典型流转：tip_clipping → tip_clip_img → tip_clipping → tip_clip_ok
 *
 * @typedef {'progress' | 'transient'} TipModeValue
 * @typedef {'tip_clipping' | 'tip_clip_img' | 'tip_clip_ok' | 'tip_clip_database_incomplete' | 'tip_token_miss' | 'tip_token_invalid' | 'tip_save_path_miss' | 'tip_siyuan_kernel_unavailable' | 'tip_no_selection' | 'tip_readability_failed'} TipKey
 */

const TIP_MODE = {
    PROGRESS: "progress",
    TRANSIENT: "transient",
};

/** @type {Record<TipKey, TipModeValue>} */
const TIP_BEHAVIOR = {
    tip_clipping: TIP_MODE.PROGRESS,
    tip_clip_img: TIP_MODE.PROGRESS,
    tip_clip_ok: TIP_MODE.TRANSIENT,
    tip_clip_database_incomplete: TIP_MODE.TRANSIENT,
    tip_token_miss: TIP_MODE.TRANSIENT,
    tip_token_invalid: TIP_MODE.TRANSIENT,
    tip_save_path_miss: TIP_MODE.TRANSIENT,
    tip_siyuan_kernel_unavailable: TIP_MODE.TRANSIENT,
    tip_no_selection: TIP_MODE.TRANSIENT,
    tip_readability_failed: TIP_MODE.TRANSIENT,
};

/** @type {ReturnType<typeof setTimeout> | null} */
let tipTimeoutId;
/** @type {ReturnType<typeof setTimeout> | null} */
let tipHideAnimTimeoutId;

const siyuanCancelTipHideAnimation = () => {
    if (tipHideAnimTimeoutId) {
        clearTimeout(tipHideAnimTimeoutId);
        tipHideAnimTimeoutId = null;
    }
};

/** @param {HTMLElement} tip */
const siyuanAnimateTipIn = (tip) => {
    requestAnimationFrame(() => {
        requestAnimationFrame(() => {
            tip.style.transform = "translate3d(-50%, 0, 0) scale(0.8)";
            tip.style.opacity = "1";
        });
    });
};

/**
 * @param {string} msg
 * @returns {HTMLElement}
 */
const siyuanMountTipElement = (msg) => {
    siyuanCancelTipHideAnimation();
    document.getElementById("siyuanmessage")?.remove();

    const tip = document.createElement("div");
    tip.id = "siyuanmessage";
    tip.style.cssText =
        "position:fixed;top:16px;left:50%;z-index:999999999;line-height:20px;border-radius:4px;padding:8px 16px;color:#fff;font-size:inherit;background-color:#4285f4;box-sizing:border-box;box-shadow:0 3px 5px -1px rgba(0,0,0,0.2),0 6px 10px 0 rgba(0,0,0,0.14),0 1px 18px 0 rgba(0,0,0,0.12);transition:opacity 0.15s cubic-bezier(0,0,0.2,1) 0ms,transform 0.15s cubic-bezier(0,0,0.2,1) 0ms;word-break:break-word;max-width:80vw;";
    tip.innerHTML = msg;
    tip.style.transform = "translate3d(-50%, -100px, 0) scale(0.8)";
    tip.style.opacity = "0";
    document.body.appendChild(tip);
    siyuanAnimateTipIn(tip);
    return tip;
};

/**
 * @param {string} msg 提示文案（HTML）
 * @param {TipKey | string} [key] 查 {@link TIP_BEHAVIOR}，省略时为 transient
 * @param {number} [timeout] transient 隐藏延迟（毫秒）
 */
const siyuanShowTip = (msg, key, timeout) => {
    const isProgress = key && TIP_BEHAVIOR[key] === TIP_MODE.PROGRESS;
    const existingTip = document.getElementById("siyuanmessage");

    siyuanCancelTipHideAnimation();

    if (existingTip && existingTip.style.opacity !== "0") {
        // progress 或 tip_clip_ok 等：同一轮展示中只换文案，不重新弹出
        existingTip.innerHTML = msg;
    } else {
        siyuanMountTipElement(msg);
    }

    if (tipTimeoutId) {
        clearTimeout(tipTimeoutId);
        tipTimeoutId = null;
    }

    if (isProgress) {
        return;
    }

    tipTimeoutId = setTimeout(() => {
        siyuanClearTip();
    }, timeout || 5000);
};

// Add i18n support https://github.com/siyuan-note/siyuan/issues/13559
/**
 * @param {TipKey | string} msgKey
 * @param {number} [timeout]
 * @param {(msg: string) => string} [format]
 */
const siyuanShowTipByKey = async (msgKey, timeout, format) => {
    await siyuanLangReady;
    const msg = format ? format(siyuanGetMessage(msgKey)) : siyuanGetMessage(msgKey);
    siyuanShowTip(msg, msgKey, timeout);
};

/** 收起动画结束后移除元素，并清除 transient 定时器 */
const siyuanClearTip = () => {
    if (tipTimeoutId) {
        clearTimeout(tipTimeoutId);
        tipTimeoutId = null;
    }

    const tip = document.getElementById("siyuanmessage");
    if (!tip) {
        return;
    }

    siyuanCancelTipHideAnimation();
    tip.style.transform = "translate3d(-50%, -100px, 0) scale(0.8)";
    tip.style.opacity = "0";
    tipHideAnimTimeoutId = setTimeout(() => {
        tip.remove();
        tipHideAnimTimeoutId = null;
    }, 150);
};

const siyuanConvertBlobToBase64 = (blob) =>
    new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onerror = reject;
        reader.onload = () => resolve(reader.result);
        reader.readAsDataURL(blob);
    });

const SIYUAN_CLIP_IMAGE_INDEX_ATTR = "data-siyuan-clip-image-index";

const siyuanIsYuquePage = () => {
    return window.location.hostname === "yuque.com" || window.location.hostname.endsWith(".yuque.com");
};

const siyuanGetImageSource = (image) => {
    const source = image.getAttribute("src") ||
        image.currentSrc ||
        image.getAttribute("data-src") ||
        image.getAttribute("data-original") ||
        image.getAttribute("data-origin-src") ||
        image.getAttribute("data-lazy-src");
    if (!source) {
        return "";
    }
    try {
        return new URL(source, document.baseURI).href;
    } catch (e) {
        return source;
    }
};

const siyuanIsYuqueCardReady = (card) => {
    if (card.getAttribute("data-card-name") === "codeblock") {
        return !!card.querySelector(".cm-content");
    }
    const image = card.querySelector("img");
    return !!image && "" !== siyuanGetImageSource(image);
};

const siyuanWaitForYuqueCard = (card, timeout = 2000) => {
    if (siyuanIsYuqueCardReady(card)) {
        return Promise.resolve(true);
    }
    return new Promise((resolve) => {
        let completed = false;
        const complete = (ready) => {
            if (completed) {
                return;
            }
            completed = true;
            observer.disconnect();
            clearTimeout(timer);
            resolve(ready);
        };
        const observer = new MutationObserver(() => {
            if (siyuanIsYuqueCardReady(card)) {
                complete(true);
            }
        });
        const timer = setTimeout(() => complete(siyuanIsYuqueCardReady(card)), timeout);
        observer.observe(card, {
            attributes: true,
            attributeFilter: ["src", "data-src", "data-original", "data-origin-src", "data-lazy-src"],
            childList: true,
            subtree: true,
        });
        card.scrollIntoView({behavior: "auto", block: "center", inline: "nearest"});
    });
};

const siyuanPrepareYuqueCards = async (doc) => {
    if (!siyuanIsYuquePage()) {
        return {cards: 0, initiallyReady: 0, rendered: 0, unresolved: 0};
    }

    const cards = Array.from(doc.querySelectorAll(
        'ne-card[data-card-name="image"], ne-card[data-card-name="codeblock"]'
    ));
    const scrollX = window.scrollX;
    const scrollY = window.scrollY;
    let initiallyReady = 0;
    let rendered = 0;

    try {
        for (const card of cards) {
            if (siyuanIsYuqueCardReady(card)) {
                initiallyReady++;
                continue;
            }
            if (await siyuanWaitForYuqueCard(card)) {
                rendered++;
            }
        }
    } finally {
        window.scrollTo(scrollX, scrollY);
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    }

    return {
        cards: cards.length,
        initiallyReady,
        rendered,
        unresolved: cards.filter((card) => !siyuanIsYuqueCardReady(card)).length,
    };
};

const siyuanPrepareYuqueImages = (sourceDoc, clonedDoc) => {
    if (!siyuanIsYuquePage()) {
        return [];
    }

    const selector = ".yuque-doc-content img";
    const sourceImages = Array.from(sourceDoc.querySelectorAll(selector));
    const clonedImages = Array.from(clonedDoc.querySelectorAll(selector));
    return sourceImages.map((sourceImage, index) => {
        const src = siyuanGetImageSource(sourceImage);
        const clonedImage = clonedImages[index];
        if (clonedImage) {
            clonedImage.setAttribute(SIYUAN_CLIP_IMAGE_INDEX_ATTR, index.toString());
            if (src) {
                clonedImage.setAttribute("src", src);
            }
        }
        return {
            src,
            alt: sourceImage.getAttribute("alt") || "",
        };
    });
};

const siyuanNormalizeYuqueCodeBlocks = (doc) => {
    if (!siyuanIsYuquePage()) {
        return {normalized: 0, unresolved: 0};
    }

    let normalized = 0;
    let unresolved = 0;
    doc.querySelectorAll('ne-card[data-card-name="codeblock"]').forEach((card) => {
        const content = card.querySelector(".cm-content");
        if (!content) {
            unresolved++;
            return;
        }

        const lines = Array.from(content.querySelectorAll(".cm-line"));
        const codeText = 0 < lines.length
            ? lines.map((line) => line.textContent).join("\n")
            : content.textContent;
        const pre = doc.createElement("pre");
        const code = doc.createElement("code");
        code.textContent = codeText;
        pre.appendChild(code);
        card.replaceWith(pre);
        normalized++;
    });
    return {normalized, unresolved};
};

const siyuanRestoreYuqueImages = (root, imageSources) => {
    if (!siyuanIsYuquePage() || 0 === imageSources.length) {
        return 0;
    }

    const sourcesByAlt = new Map();
    imageSources.forEach((source, index) => {
        if (!source.src || !source.alt) {
            return;
        }
        const sources = sourcesByAlt.get(source.alt) || [];
        sources.push({index, src: source.src});
        sourcesByAlt.set(source.alt, sources);
    });

    const usedSourceIndexes = new Set();
    let restored = 0;
    root.querySelectorAll("img").forEach((image) => {
        if (siyuanGetImageSource(image)) {
            image.removeAttribute(SIYUAN_CLIP_IMAGE_INDEX_ATTR);
            return;
        }

        const sourceIndex = Number.parseInt(image.getAttribute(SIYUAN_CLIP_IMAGE_INDEX_ATTR), 10);
        let source = Number.isInteger(sourceIndex) ? imageSources[sourceIndex] : undefined;
        if (!source?.src) {
            const altSources = sourcesByAlt.get(image.getAttribute("alt") || "") || [];
            const altSource = altSources.find((item) => !usedSourceIndexes.has(item.index));
            if (altSource) {
                source = altSource;
                usedSourceIndexes.add(altSource.index);
            }
        } else {
            usedSourceIndexes.add(sourceIndex);
        }

        if (source?.src) {
            image.setAttribute("src", source.src);
            restored++;
        }
        image.removeAttribute(SIYUAN_CLIP_IMAGE_INDEX_ATTR);
    });
    return restored;
};

// 网页换行用 span 样式 word-break 的特殊处理 https://github.com/siyuan-note/siyuan/issues/13195
function siyuanIsSpanTextProtected(element) {
    return ["PRE", "CODE", "MATH", "SCRIPT", "STYLE", "TEXTAREA"].includes(element.tagName.toUpperCase()) ||
        element.hasAttribute("data-formula") ||
        /math|latex|katex|mjx|equation|formula/i.test(String(element.className || ""));
}

function isIgnoredElement(element) {
    // 递归查找父元素直到找到 pre、code、span、math 或 math相关标签
    while (element) {
        if (siyuanIsSpanTextProtected(element)) {
            return true;
        }

        element = element.parentElement; // 移动到父元素
        if (!element) {
            break;
        }

        const tagName = element.tagName.toLowerCase();

        // 如果父元素是 pre、code、span、math 或与数学相关的类名
        if (["pre", "code", "span", "section"].includes(tagName)) {
            return true;
        } else if (["div", "p"].includes(tagName)) {
            return siyuanIsSpanTextProtected(element);
        }
    }
    return false; // 没找到时返回 false
}

// span元素的换行处理优化：https://github.com/siyuan-note/siyuan/issues/14775
// 规范：https://developer.mozilla.org/zh-CN/docs/Web/CSS/white-space
function siyuanProcessTextByWhiteSpace(element) {
    const doc = element.ownerDocument;
    const visit = (parent) => {
        // 代码、公式和非正文节点中的换行由各自的转换流程处理。
        if (siyuanIsSpanTextProtected(parent)) {
            return;
        }
        Array.from(parent.childNodes).forEach((node) => {
            if (node.nodeType === Node.ELEMENT_NODE) {
                visit(node);
                return;
            }
            if (node.nodeType !== Node.TEXT_NODE || !node.textContent.includes("\n")) {
                return;
            }
            let text = node.textContent;
            const whiteSpace = window.getComputedStyle(parent).whiteSpace;
            if (!["pre", "pre-wrap", "break-spaces"].includes(whiteSpace)) {
                text = text.replace(/[ \t\r\f\v]+/g, " ").replace(/[ \t]+\n/g, "\n");
            }
            if (!["pre", "break-spaces"].includes(whiteSpace)) {
                text = text.replace(/\n+/g, "\n");
            }
            // 按文本节点插入换行，保留行内元素、节点间空格和字面 HTML 文本。
            const fragment = doc.createDocumentFragment();
            text.split("\n").forEach((line, index) => {
                if (index > 0) {
                    fragment.appendChild(doc.createElement("br"));
                }
                fragment.appendChild(doc.createTextNode(line));
            });
            parent.replaceChild(fragment, node);
        });
    };
    visit(element);
}

// 处理会换行的 span 后添加 <br>，让内核能识别到换行
function siyuanSpansAddBr(tempElement) {
    const spans = tempElement.querySelectorAll("span");
    if (!spans || spans.length === 0) {
        console.log("No span elements found.");
        return;
    }

    // 用于存储符合条件的 span 元素
    const matchedSpans = [];

    spans.forEach((span) => {
        const style = window.getComputedStyle(span);

        // 现有的条件判断，判断是否满足换行条件
        if (
            (style.whiteSpace.trim().toLowerCase() === "normal" ||
                style.whiteSpace.trim().toLowerCase() === "pre-wrap") &&
            (style.wordWrap.trim().toLowerCase() === "break-word" ||
                style.overflowWrap.trim().toLowerCase() === "break-word" ||
                style.wordBreak.trim().toLowerCase() === "break-word")
        ) {
            // 检查父元素是否是 pre、code 或 span
            if (isIgnoredElement(span)) {
                console.log("Skipping span due to parent being pre, code or span.");
                return; // 如果父元素是 pre、code 或 span 或者数学公式，跳过该 span
            }

            siyuanProcessTextByWhiteSpace(span);

            // 添加到符合条件的数组中
            matchedSpans.push(span);
        }
    });

    if (matchedSpans.length > 0) {
        console.log(`Added <br> for ${matchedSpans.length} span elements.(Total span: ${spans.length})`);
        console.log("Matched span elements:", matchedSpans);
    } else {
        console.log("No span elements matched the criteria.");
    }
}

// 替换粗体样式为内核可识别<b>标签 https://github.com/siyuan-note/siyuan/issues/13306
function siyuanProcessBoldStyle(tempElement) {
    // 遍历元素，根据计算字重识别粗体样式
    const boldElements = tempElement.querySelectorAll("*");

    boldElements.forEach((element) => {
        const style = window.getComputedStyle(element);
        if (["B", "STRONG"].includes(element.tagName)) {
            return; // 如果元素本身是 <b> 或 <strong> 标签，跳过
        }

        if (parentContainsBold(element)) {
            return; // 如果元素的父元素是 <b> 或 <strong> 标签，跳过
        }

        // 将半粗体及更高字重转换为粗体标签
        if (style.fontWeight === "bold" || Number(style.fontWeight) >= 600) {
            // 将 element 中的各个元素使用 <b> 标签包裹
            const children = element.childNodes;
            for (let i = 0; i < children.length; i++) {
                const child = children[i];
                if (child.nodeType === Node.TEXT_NODE) {
                    // 如果是文本节点，直接包裹在 <b> 标签中
                    const text = child.nodeValue;
                    const textElement = document.createElement("b");
                    textElement.textContent = text;
                    element.replaceChild(textElement, child);
                } else if (child.nodeType === Node.ELEMENT_NODE) {
                    // 如果是元素节点，递归处理
                    const childElement = child;
                    const childTagName = childElement.tagName.toLowerCase();
                    if (["b", "strong"].includes(childTagName)) {
                        continue; // 如果是 <b> 或 <strong> 标签，跳过
                    }
                    if (parentContainsBold(childElement)) {
                        continue; // 如果元素的父元素是 <b> 或 <strong> 标签，跳过
                    }
                    // 递归处理
                    siyuanProcessBoldStyle(childElement);
                }
            }
        }
    });
}

function parentContainsBold(element) {
    let parent = element.parentElement;
    while (parent) {
        if (["B", "STRONG", "H1", "H2", "H3", "H4", "H5", "H6"].includes(parent.tagName)) {
            return true;
        }
        parent = parent.parentElement;
    }
    return false;
}

// 替换斜体样式为内核可识别 <i> 标签 https://github.com/siyuan-note/siyuan/issues/13306
function siyuanProcessItalicStyle(tempElement) {
    // 获取所有元素
    const allElements = tempElement.querySelectorAll("*");

    allElements.forEach((element) => {
        const style = window.getComputedStyle(element);
        if (["I", "EM"].includes(element.tagName)) {
            return; // 如果元素本身是 <i> 或 <em> 标签，跳过
        }

        if (parentContainsItalic(element)) {
            return; // 如果元素的父元素是 I 或 EM 标签，跳过
        }

        // 判断是否具有 font-style: italic
        if (style.fontStyle === "italic") {
            // 将 element 中的各个元素使用 <i> 标签包裹
            const children = element.childNodes;
            for (let i = 0; i < children.length; i++) {
                const child = children[i];
                if (child.nodeType === Node.TEXT_NODE) {
                    // 如果是文本节点，直接包裹在 <i> 标签中
                    const text = child.nodeValue;
                    const textElement = document.createElement("i");
                    textElement.textContent = text;
                    element.replaceChild(textElement, child);
                } else if (child.nodeType === Node.ELEMENT_NODE) {
                    // 如果是元素节点，递归处理
                    const childElement = child;
                    const childTagName = childElement.tagName.toLowerCase();
                    if (["i", "em"].includes(childTagName)) {
                        continue; // 如果是 <i> 或 <em> 标签，跳过
                    }
                    if (parentContainsItalic(childElement)) {
                        continue; // 如果元素的父元素是 I 或 EM 标签，跳过
                    }
                    // 递归处理
                    siyuanProcessItalicStyle(childElement);
                }
            }
        }
    });
}

function parentContainsItalic(element) {
    let parent = element.parentElement;
    while (parent) {
        if (["I", "EM"].includes(parent.tagName)) {
            return true;
        }
        parent = parent.parentElement;
    }
    return false;
}

function siyuanProcessUnderlineStyle(tempElement) {
    // 获取所有元素
    const allElements = tempElement.querySelectorAll("*");

    allElements.forEach((element) => {
        const style = window.getComputedStyle(element);
        if (element.tagName === "U") {
            return; // 如果元素本身是 <u> 标签，跳过
        }

        if (parentContainsUnderline(element)) {
            return; // 如果元素的父元素是 U 标签，跳过
        }

        // 判断是否具有 text-decoration: underline
        if (style.textDecorationLine.includes("underline")) {
            // 将 element 中的各个元素使用 <u> 标签包裹
            const children = element.childNodes;
            for (let i = 0; i < children.length; i++) {
                const child = children[i];
                if (child.nodeType === Node.TEXT_NODE) {
                    // 如果是文本节点，直接包裹在 <u> 标签中
                    const text = child.nodeValue;
                    const textElement = document.createElement("u");
                    textElement.textContent = text;
                    element.replaceChild(textElement, child);
                } else if (child.nodeType === Node.ELEMENT_NODE) {
                    // 如果是元素节点，递归处理
                    const childElement = child;
                    const childTagName = childElement.tagName.toLowerCase();
                    if (childTagName === "u") {
                        continue; // 如果是 <u> 标签，跳过
                    }
                    if (parentContainsUnderline(childElement)) {
                        continue; // 如果元素的父元素是 U 标签，跳过
                    }
                    // 递归处理
                    siyuanProcessUnderlineStyle(childElement);
                }
            }
        }
    });

    function parentContainsUnderline(element) {
        let parent = element.parentElement;
        while (parent) {
            if (parent.tagName === "U") {
                return true;
            }
            parent = parent.parentElement;
        }
        return false;
    }
}

const FORMULA_SELECTOR = "[data-formula]";

function simplifyNestedTags(root, tagName) {
    let elements = root.querySelectorAll(tagName);
    let hasNested = true;

    while (hasNested) {
        hasNested = false;
        elements.forEach((element) => {
            if (!element.closest(FORMULA_SELECTOR) && simplifyElement(element, tagName)) {
                hasNested = true;
            }
        });
        elements = root.querySelectorAll(tagName);
    }

    function simplifyElement(element, tagName) {
        let nestedFound = false;

        Array.from(element.children).forEach((child) => {
            if (child.matches(FORMULA_SELECTOR)) {
                return;
            }

            if (child.tagName === tagName) {
                nestedFound = true;
                while (child.firstChild) {
                    element.insertBefore(child.firstChild, child);
                }
                child.remove();
            } else {
                nestedFound = simplifyElement(child, tagName) || nestedFound;
            }
        });

        return nestedFound;
    }
}

// 移除图片链接 https://github.com/siyuan-note/siyuan/issues/13941
function siyuanRemoveImgLink(tempElement) {
    const images = tempElement.querySelectorAll("img");
    images.forEach((image) => {
        const parent = image.parentElement;
        if (!parent) {
            return;
        }

        if (parent.tagName === "A") {
            const grandParent = parent.parentElement;
            if (!grandParent) {
                return;
            }
            grandParent.insertBefore(image, parent);
            parent.remove();
        }
    });
}

// 将 SVG 转换为 Base64 编码的 Data URI https://github.com/siyuan-note/siyuan/issues/14523
// 修复网页内嵌SVG包含非Latin字符导致剪藏报错 https://github.com/siyuan-note/siyuan/issues/14669
async function siyuanSvgToBase64(svgNode) {
    const serializer = new XMLSerializer();
    let svgStr = serializer.serializeToString(svgNode);

    if (!svgStr.startsWith("<?xml")) {
        svgStr = '<?xml version="1.0" encoding="UTF-8"?>' + svgStr;
    }

    const svgBlob = new Blob([svgStr], {type: "image/svg+xml"});

    const dataUrl = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onloadend = () => resolve(reader.result);
        reader.onerror = reject;
        reader.readAsDataURL(svgBlob);
    });

    return dataUrl; // 返回 base64 编码的 data URL
}

async function siyuanSvgToImg(tempElement) {
    const svgElements = tempElement.querySelectorAll("svg");
    console.log(`Found ${svgElements.length} SVG elements`);

    for (const svg of svgElements) {
        const img = document.createElement("img");
        img.src = await siyuanSvgToBase64(svg);
        img.style.cssText = window.getComputedStyle(svg).cssText;
        svg.parentNode.replaceChild(img, svg);
    }
}

// 知乎附加的搜索推荐和直答跳转不属于作者正文，仅清理剪藏副本。
function siyuanCleanZhihu(root, sourceURL) {
    let hostname;
    try {
        hostname = new URL(sourceURL).hostname;
    } catch {
        return;
    }
    if (hostname !== "zhihu.com" && !hostname.endsWith(".zhihu.com")) {
        return;
    }
    root.querySelectorAll(".HotSearchCard").forEach((card) => card.remove());
    root.querySelectorAll("a.RichContent-EntityWord").forEach((link) => {
        // 直答图标可能已由 SVG 实验选项转换为图片。
        link.querySelectorAll("svg, img").forEach((icon) => icon.remove());
        while (link.firstChild) {
            link.parentNode.insertBefore(link.firstChild, link);
        }
        link.remove();
    });
}

function adaptMSN(tempDoc) {
    if (tempDoc.documentURI.indexOf("msn.cn") !== -1) {
        // 删除掉其他不相关文章
        const articles = tempDoc.querySelectorAll(".consumption-page-gridarea_content");
        articles.forEach((article) => {
            const shadowHost = article.querySelector("views-header-wc");
            if (!shadowHost) {
                return;
            }
            if (!shadowHost.shadowRoot) {
                return;
            }

            const titleEle = shadowHost.shadowRoot.querySelector("h1");
            if (!titleEle) {
                return;
            }

            if (titleEle.innerText.indexOf(tempDoc.title) === -1) {
                article.remove();
            }
        });

        // 将 Shadow DOM 展开
        const shadowHosts = tempDoc.querySelectorAll("cp-article");
        shadowHosts.forEach((element) => {
            const shadowRoot = element.shadowRoot;
            if (!shadowRoot) {
                return;
            }

            const slots = shadowRoot.querySelectorAll("slot");
            slots.forEach((slot) => {
                const slotName = slot.getAttribute("name");
                element.querySelectorAll(`[slot="${slotName}"]`).forEach((slotElement) => {
                    const imgEle = slotElement.querySelector("cp-article-image");
                    if (!imgEle) {
                        return;
                    }
                    const imgShadowRoot = imgEle.shadowRoot;
                    if (!imgShadowRoot) {
                        return;
                    }
                    const imgs = imgShadowRoot.querySelectorAll("img");
                    if (!imgs || imgs.length === 0) {
                        return;
                    }
                    slotElement.innerHTML = "";
                    imgs.forEach((img) => {
                        slotElement.appendChild(img.cloneNode(true));
                    });
                    slot.innerHTML = slotElement.innerHTML;
                });
            });

            const shadowContent = shadowRoot.innerHTML;
            const newDiv = tempDoc.createElement("div");
            newDiv.innerHTML = shadowContent;
            element.parentNode.replaceChild(newDiv, element);
        });
    }
}

// Readability 前处理 https://github.com/siyuan-note/siyuan/issues/13306
async function siyuanGetCloneNode(tempDoc) {
    let items;
    try {
        items = await new Promise((resolve, reject) => {
            chrome.storage.sync.get(siyuanStorageDefaultsFor(SIYUAN_EXP_STORAGE_KEYS), (result) => {
                if (chrome.runtime.lastError) {
                    reject(chrome.runtime.lastError);
                } else {
                    resolve(result);
                }
            });
        });
    } catch (error) {
        console.error("获取失败，错误信息：", error);
        items = siyuanStorageDefaultsFor(SIYUAN_EXP_STORAGE_KEYS);
    }

    // 适配 MSN 页面 https://github.com/siyuan-note/siyuan/issues/14197
    adaptMSN(tempDoc);

    if (items.expBold) {
        // 替换粗体样式为内核可识别 <b> 标签 https://github.com/siyuan-note/siyuan/issues/13306
        siyuanProcessBoldStyle(tempDoc);
    }

    if (items.expItalic) {
        // 替换斜体样式为内核可识别 <i> 标签 https://github.com/siyuan-note/siyuan/issues/13306
        siyuanProcessItalicStyle(tempDoc);
    }

    if (items.expUnderline) {
        // 替换下划线样式为内核可识别 <u> 标签
        siyuanProcessUnderlineStyle(tempDoc);
    }

    if (items.expRemoveImgLink) {
        // 移除图片链接 https://github.com/siyuan-note/siyuan/issues/13941
        siyuanRemoveImgLink(tempDoc);
    }

    if (items.expSpan) {
        // 网页换行用 span 样式 word-break 的特殊处理 https://github.com/siyuan-note/siyuan/issues/13195
        // 处理会换行的 span 后添加 <br>，让内核能识别到换行
        siyuanSpansAddBr(tempDoc);
    }

    if (items.expSvgToImg) {
        // 将网页内嵌的 SVG 节点转换成内嵌的 IMG 节点
        // https://github.com/siyuan-note/siyuan/issues/14523
        await siyuanSvgToImg(tempDoc);
    }

    // 合并嵌套的标签
    simplifyNestedTags(tempDoc, "STRONG");
    simplifyNestedTags(tempDoc, "B");
    simplifyNestedTags(tempDoc, "I");
    simplifyNestedTags(tempDoc, "EM");

    // 如果公式被嵌套包裹，则去掉外层包裹 https://github.com/siyuan-note/siyuan/issues/14382
    const mathElements = tempDoc.querySelectorAll(".ztext-math");
    mathElements.forEach((mathElement) => {
        const mathParent = mathElement.parentElement;
        if (mathParent && ["B", "STRONG", "I", "EM"].includes(mathParent.tagName)) {
            const parent = mathParent;
            while (parent.firstChild) {
                parent.parentNode.insertBefore(parent.firstChild, parent);
            }
            parent.remove();
        }
    });

    // 如果行级标签包含了块级标签，则将该行级标签改为 div
    fixInvalidNesting(tempDoc);

    const clonedDoc = document.cloneNode(true);
    siyuanNormalizePictureImages(clonedDoc, document.baseURI, Array.from(document.querySelectorAll("img")));
    return clonedDoc;
}

/**
 * 修复 HTML 结构：将包含块级元素的行级标签改为 div
 * @param {Document|Element} doc - 需要处理的 DOM 文档或元素节点
 */
function fixInvalidNesting(doc) {
    const inlineTags = ["span", "strong", "b", "i", "em", "a"];
    // 注意：code 建议移出行内标签列表，因为它通常被视为行内元素
    const blockTags = [
        "div",
        "p",
        "h1",
        "h2",
        "h3",
        "h4",
        "h5",
        "h6",
        "ul",
        "ol",
        "li",
        "table",
        "tr",
        "td",
        "th",
        "blockquote",
        "section",
        "article",
    ];

    const ownerDocument = doc.ownerDocument || doc;
    const inlineSelector = inlineTags.join(",");
    const blockSelector = blockTags.join(",");

    // 标题元素只能包含行内内容，先将第一个块级后代及其后续内容移到标题外
    const invalidHeadings = Array.from(doc.querySelectorAll("h1, h2, h3, h4, h5, h6"))
        .filter((heading) => heading.querySelector(blockSelector));
    invalidHeadings.forEach((heading) => {
        const firstBlock = heading.querySelector(blockSelector);
        if (!firstBlock || !heading.parentNode) {
            return;
        }

        const range = ownerDocument.createRange();
        range.selectNodeContents(heading);
        range.setEndBefore(firstBlock);

        const normalizedHeading = heading.cloneNode(false);
        normalizedHeading.appendChild(range.extractContents());

        const trailingContent = ownerDocument.createDocumentFragment();
        while (heading.firstChild) {
            trailingContent.appendChild(heading.firstChild);
        }

        const parent = heading.parentNode;
        parent.insertBefore(normalizedHeading, heading);
        parent.insertBefore(trailingContent, heading);
        heading.remove();
    });

    // 1. 获取所有可能是行内的元素
    const allInlines = Array.from(doc.querySelectorAll(inlineSelector));

    // 2. 过滤出真正包含块级子元素的行内元素
    // 使用 reverse() 从 DOM 树的最深层开始处理，防止父级先被替换导致子级丢失
    const targets = allInlines.filter((el) => el.querySelector(blockSelector)).reverse();

    targets.forEach((oldEl) => {
        // 再次检查 oldEl 是否还在 DOM 树中（防止在之前的循环中已被父级替换）
        if (!oldEl.parentNode) return;

        const newDiv = ownerDocument.createElement("div");

        // 复制属性
        for (const attr of oldEl.attributes) {
            newDiv.setAttribute(attr.name, attr.value);
        }

        // 转移子节点
        while (oldEl.firstChild) {
            newDiv.appendChild(oldEl.firstChild);
        }

        // 替换
        oldEl.parentNode.replaceChild(newDiv, oldEl);
    });
}

const setMathJaxDataFormula = () => {
    return new Promise((resolve) => {
        const script = document.createElement("script");
        script.src = chrome.runtime.getURL("lib/mathjax.js");
        (document.head || document.documentElement).appendChild(script);

        const cleanUp = () => {
            try {
                script.remove();
            } catch (e) {
            }
            resolve();
        };

        script.onload = cleanUp;
        script.onerror = () => {
            console.warn("MathJax load failed");
            cleanUp();
        };
    });
};

const siyuanGetClipSettings = async () => {
    const items = await siyuanLoadStorageSettings();
    return { ...items, ...siyuanGetActiveSavePathSettings(items) };
};

/** @returns {Promise<object | null>} 配置与内核均就绪时返回 settings */
const siyuanEnsureClipReady = async () => {
    const items = await siyuanGetClipSettings();

    let result;
    try {
        result = await chrome.runtime.sendMessage({
            func: "check-kernel",
            data: {
                ip: items.ip,
                token: items.token,
                notebook: items.notebook,
                savePathTemplate: items.savePathTemplate,
                databaseID: items.selectedDatabaseID,
                databaseBlockID: items.selectedDatabaseBlockID,
                databaseTemplateID: items.selectedDatabaseTemplateID,
            },
        });
    } catch (e) {
        result = {ok: false, error: "tip_siyuan_kernel_unavailable"};
    }

    if (!result.ok) {
        void siyuanShowTipByKey(result.error);
        return null;
    }

    return items;
};

const siyuanSendUpload = async (tempElement, tabId, srcUrl, type, article, href, clipItems) => {
    siyuanNormalizeClipBlockStructure(tempElement);
    siyuanConvertBareClipImageURLs(tempElement);
    siyuanNormalizePictureImages(tempElement, document.baseURI);
    const items = clipItems || (await siyuanGetClipSettings());

    if (type !== "article") {
        void siyuanShowTipByKey("tip_clipping");
    }

    let srcList = [];
    if (srcUrl) {
        srcList.push(srcUrl);
    }
    const images = tempElement.querySelectorAll("img");
    images.forEach((item) => {
        let src = item.getAttribute("src");
        if (!src) {
            return;
        }

        const itemClassName = String(item.className || "");
        if (itemClassName.includes("emoji") && "" !== item.getAttribute("alt")) {
            // 图片 Emoji 直接使用 alt https://github.com/siyuan-note/siyuan/issues/13342
            return;
        }

        // 处理使用 data-original 属性的情况 https://github.com/siyuan-note/siyuan/issues/11826
        let dataOriginal = item.getAttribute("data-original");
        if (dataOriginal && !dataOriginal.startsWith("/")) {
            const isGifSource = value => /\.gif(?:[?#]|$)/i.test(value || "");
            if (isGifSource(dataOriginal) || !isGifSource(src)) src = dataOriginal;
        }

        if ("https:" === window.location.protocol) {
            if (src.startsWith("http:")) {
                src = src.replace("http:", "https:");
            } else if (src.startsWith("//")) {
                src = "https:" + src;
            }
            item.setAttribute("src", src);
        }

        if (itemClassName.includes("ztext-gif") && src.includes("zhimg.com")) {
            // Zhihu GIF thumbnails use JPG URLs; request the animated source.
            src = src.replace(/\.jpg(?=[?#]|$)/i, ".webp");
        }

        srcList.push(src);
    });

    let files = {};
    srcList = [...new Set(srcList)];

    if (!items.assets) {
        // 不剪藏资源文件 https://github.com/siyuan-note/siyuan/issues/12583
        srcList = [];
    }

    let fetchFileErr = false;
    let filesSize = 0;
    for (let i = 0; i < srcList.length; i++) {
        let src = srcList[i];
        void siyuanShowTipByKey("tip_clip_img", undefined, (msg) => `${msg} [${i}/${srcList.length}]...`);
        let response;
        try {
            // Wikipedia 使用图片原图 https://github.com/siyuan-note/siyuan/issues/11640
            if (-1 !== src.indexOf("wikipedia/commons/thumb/")) {
                let idx = src.lastIndexOf(".");
                let ext = src.substring(idx);
                if (0 < src.indexOf(".svg.png")) {
                    ext = ".svg";
                }
                idx = src.indexOf(ext + "/");
                if (0 < idx) {
                    src = src.substring(0, idx + ext.length);
                    src = src.replace("/commons/thumb/", "/commons/");
                }
            }
            response = await fetch(src, {
                headers: {
                    accept: "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8",
                    "sec-fetch-dest": "image",
                },
            });
        } catch (e) {
            console.warn("fetch [" + src + "] failed", e);
            fetchFileErr = true;
            continue;
        }
        if (!response.ok) {
            console.warn("fetch [" + src + "] HTTP " + response.status);
            fetchFileErr = true;
            continue;
        }
        const image = await response.blob();
        const data = await siyuanConvertBlobToBase64(image);
        const contentType = (response.headers?.get("content-type") || image.type || "")
            .split(";")[0].trim().toLowerCase();
        files[escape(src)] = {
            type: image.type || contentType || "application/octet-stream",
            data,
        };

        filesSize += data.length;
        if (1000 * 1000 * 60 < filesSize) {
            // 下载图片总大小超过 60MB 时走内核剪藏
            fetchFileErr = true;
            files = {};
            console.warn("Total image size exceeds 60MB, fallback to kernel netImg2LocalAssets");
            break;
        }
    }

    let title = article && article.title ? article.title : document.title || "";
    let siteName = article && article.siteName ? article.siteName : "";
    let excerpt = article && article.excerpt ? article.excerpt : "";
    let url = href || window.location.href;

    const msgJSON = {
        fetchFileErr,
        files: files,
        dom: tempElement.innerHTML,
        api: items.ip,
        token: items.token,
        savePathMode: items.savePathMode,
        notebook: items.notebook,
        parentDoc: items.parentDoc,
        savePathTemplate: items.savePathTemplate,
        tags: items.tags,
        assets: items.assets,
        tip: items.showTip,
        title: title,
        siteName: siteName,
        excerpt: excerpt,
        listDocTree: items.expListDocTree,
        href: url,
        type,
        tabId,
        selectedDatabaseID: items.selectedDatabaseID,
        selectedDatabaseBlockID: items.selectedDatabaseBlockID,
        selectedDatabaseViewID: items.selectedDatabaseViewID,
        selectedDatabaseTemplateID: items.selectedDatabaseTemplateID,
    };
    if (srcList.length > 0) {
        void siyuanShowTipByKey("tip_clipping");
    }
    chrome.runtime.sendMessage({func: "upload-copy", data: msgJSON});
};

const copyToClipboard = async (textToCopy) => {
    // 修复无焦点的未捕获异常：https://github.com/siyuan-note/siyuan/issues/13208
    await new Promise((resolve) => requestAnimationFrame(resolve));

    if (navigator.clipboard && window.isSecureContext) {
        try {
            return await navigator.clipboard.writeText(textToCopy);
        } catch (error) {
            //console.warn('Failed to copy text: ', error);
        }
    }

    let textArea = document.createElement("textarea");
    textArea.value = textToCopy;
    textArea.style.position = "fixed";
    textArea.style.left = "-999999px";
    textArea.style.top = "-999999px";
    document.body.appendChild(textArea);
    textArea.focus();
    textArea.select();
    return new Promise((res, rej) => {
        document.execCommand("copy") ? res() : rej();
        textArea.remove();
    });
};


const SIYUAN_DOM_PICKER_STYLE_ID = "siyuan-dom-picker-style";
let siyuanPickerState = null;

function siyuanStartElementPicker(tabId) {
    siyuanStopElementPicker();
    const style = document.createElement("style");
    style.id = SIYUAN_DOM_PICKER_STYLE_ID;
    style.textContent = `
        #siyuan-dom-picker-banner{position:fixed;z-index:2147483647;top:12px;left:50%;transform:translateX(-50%);display:flex;align-items:center;gap:10px;max-width:min(92vw,720px);padding:10px 14px;border-radius:12px;color:#fff;background:#202124;box-shadow:0 8px 30px #0005;font:13px/1.4 system-ui,sans-serif}
        #siyuan-dom-picker-banner button{border:0;border-radius:7px;padding:6px 10px;cursor:pointer;font:inherit;color:#202124;background:#fff}
        #siyuan-dom-picker-banner button[data-primary]{color:#fff;background:#4285f4}
        #siyuan-dom-picker-highlight{position:fixed;z-index:2147483646;pointer-events:none;border:2px solid #4285f4;background:#4285f422;border-radius:3px}
    `;
    (document.head || document.documentElement).appendChild(style);
    const banner = document.createElement("div");
    banner.id = "siyuan-dom-picker-banner";
    banner.innerHTML = `<span>${siyuanGetMessage("picker_hint")}</span><button type="button" data-primary>${siyuanGetMessage("picker_capture")}</button><button type="button" data-cancel>${siyuanGetMessage("picker_cancel")}</button>`;
    document.documentElement.appendChild(banner);
    const highlight = document.createElement("div");
    highlight.id = "siyuan-dom-picker-highlight";
    highlight.hidden = true;
    document.documentElement.appendChild(highlight);
    const state = {style,banner,highlight,tabId,current:null,previousCursor:document.documentElement.style.cursor};
    siyuanPickerState = state;
    document.documentElement.style.cursor = "crosshair";
    const update = element => {
        const rect = element.getBoundingClientRect();
        highlight.style.left = `${Math.max(0,rect.left)}px`;
        highlight.style.top = `${Math.max(0,rect.top)}px`;
        highlight.style.width = `${Math.max(0,rect.width)}px`;
        highlight.style.height = `${Math.max(0,rect.height)}px`;
        highlight.hidden = rect.width <= 0 || rect.height <= 0;
    };
    state.onMove = event => {
        if (banner.contains(event.target)) return;
        const element = event.composedPath().find(item =>
            item instanceof Element && item !== document.documentElement && item !== document.body &&
            !item.closest("#siyuan-dom-picker-banner") && !item.closest("#siyuan-dom-picker-highlight"));
        if (!element) return;
        state.current = element;
        update(element);
    };
    state.onClick = event => {
        if (banner.contains(event.target)) return;
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();
        if (state.current) void siyuanShowTipByKey("picker_selected", 3000);
    };
    state.onKey = event => {
        if (event.key === "Escape") {
            event.preventDefault();
            siyuanStopElementPicker();
        } else if (event.key === "Enter" && state.current) {
            event.preventDefault();
            void siyuanCaptureElement(state.current, tabId);
        } else if ((event.key === "ArrowUp" || event.key === "Backspace") && state.current?.parentElement) {
            event.preventDefault();
            state.current = state.current.parentElement;
            update(state.current);
        }
    };
    state.onScroll = () => { if (state.current) update(state.current); };
    state.onResize = () => { if (state.current) update(state.current); };
    banner.querySelector("[data-cancel]").addEventListener("click", siyuanStopElementPicker);
    banner.querySelector("[data-primary]").addEventListener("click", () => {
        if (state.current) void siyuanCaptureElement(state.current, tabId);
        else void siyuanShowTipByKey("picker_select_first", 2500);
    });
    document.addEventListener("mousemove",state.onMove,true);
    document.addEventListener("click",state.onClick,true);
    document.addEventListener("keydown",state.onKey,true);
    window.addEventListener("scroll",state.onScroll,true);
    window.addEventListener("resize",state.onResize);
    void siyuanShowTipByKey("picker_active",2500);
}
function siyuanStopElementPicker() {
    const state = siyuanPickerState;
    if (!state) return;
    document.removeEventListener("mousemove",state.onMove,true);
    document.removeEventListener("click",state.onClick,true);
    document.removeEventListener("keydown",state.onKey,true);
    window.removeEventListener("scroll",state.onScroll,true);
    window.removeEventListener("resize",state.onResize);
    state.style.remove();
    state.banner.remove();
    state.highlight.remove();
    document.documentElement.style.cursor = state.previousCursor;
    siyuanPickerState = null;
}
async function siyuanCaptureElement(element,tabId) {
    if (!element?.isConnected || !siyuanPickerState) return;
    siyuanStopElementPicker();
    const settings = await siyuanEnsureClipReady();
    if (!settings) return;
    const clone = element.cloneNode(true);
    siyuanCleanZhihu(clone,document.URL);
    const sourceImages = element.matches?.("img") ? [element] : Array.from(element.querySelectorAll("img"));
    const wrapper = document.createElement("div");
    wrapper.appendChild(clone);
    siyuanNormalizePictureImages(wrapper,document.baseURI,sourceImages);
    const article = {
        title:(element.getAttribute("aria-label") || element.querySelector("h1,h2,h3,h4")?.textContent || document.title || "").trim(),
        siteName:location.hostname,
        excerpt:(element.innerText || element.textContent || "").trim().slice(0,240),
    };
    siyuanSendUpload(wrapper,tabId,undefined,"article",article,location.href,settings);
}
function siyuanCreateFullDOMClone() {
    const clonedDoc = document.cloneNode(true);
    clonedDoc.querySelectorAll("script,style,noscript,template,link[rel='stylesheet'],#siyuanmessage,#siyuan-dom-picker-banner,#siyuan-dom-picker-highlight").forEach(node=>node.remove());
    clonedDoc.querySelectorAll("[hidden],[aria-hidden='true']").forEach(node=>node.remove());
    clonedDoc.querySelectorAll("input,textarea,select,button").forEach(node=>node.remove());
    clonedDoc.querySelectorAll("img").forEach(image=>{
        const source=image.currentSrc || image.getAttribute("data-src") || image.getAttribute("data-original");
        if(source) image.setAttribute("src",source);
    });
    siyuanNormalizePictureImages(clonedDoc,document.baseURI,Array.from(document.querySelectorAll("img")));
    siyuanCleanZhihu(clonedDoc,document.URL);
    return clonedDoc;
}
function siyuanGetConversationAdapter() {
    const host = location.hostname.toLowerCase();
    if (host === "gemini.google.com") {
        const turns = Array.from(document.querySelectorAll("user-query, model-response"));
        if (!turns.length) return null;
        return {
            name: "Gemini", turns,
            role: element => element.matches("user-query") ? "user" : "assistant",
            content: element => element.matches("user-query")
                ? element.querySelector(".query-text, .query-content, [class*='query-text']") || element
                : element.querySelector(".response-content, .markdown, [class*='response-content']") || element,
        };
    }
    if (host === "chatgpt.com" || host === "chat.openai.com") {
        const turns = Array.from(document.querySelectorAll("[data-message-author-role]"));
        if (!turns.length) return null;
        return {
            name: "ChatGPT", turns,
            role: element => {
                const role = element.getAttribute("data-message-author-role");
                return role === "user" ? "user" : role === "assistant" ? "assistant" : "";
            },
            content: element => element.querySelector(".markdown, [data-message-content], .text-message") || element,
        };
    }
    if (host === "claude.ai") {
        const turns = Array.from(document.querySelectorAll('[data-testid*="user-message"], [data-testid*="assistant-message"], [data-testid="chat-message"]'));
        if (!turns.length) return null;
        return {
            name: "Claude", turns,
            role: element => {
                const id = element.getAttribute("data-testid") || "";
                if (/user/i.test(id)) return "user";
                if (/assistant/i.test(id)) return "assistant";
                return element.getAttribute("data-message-author-role") || "";
            },
            content: element => element.querySelector(".font-claude-message, .prose, [class*='message-content']") || element,
        };
    }
    return null;
}

function siyuanExtractConversation() {
    const adapter = siyuanGetConversationAdapter();
    if (!adapter) return null;
    const turns = [];
    for (const element of adapter.turns) {
        const role = adapter.role(element);
        if (role !== "user" && role !== "assistant") continue;
        const parentTurn = element.parentElement?.closest(
            "user-query, model-response, [data-message-author-role], [data-testid*='user-message'], [data-testid*='assistant-message'], [data-testid='chat-message']"
        );
        if (parentTurn && adapter.turns.includes(parentTurn)) continue;
        const clone = adapter.content(element).cloneNode(true);
        clone.querySelectorAll("button,[aria-label*='Copy'],[data-testid*='copy'],[data-testid*='feedback']").forEach(node => node.remove());
        const html = clone.innerHTML.trim();
        if (!html) continue;
        turns.push({role,content:html});
    }
    if (!turns.length) return null;
    const wrapper = document.createElement("div");
    turns.forEach(turn => {
        const section = document.createElement("section");
        section.setAttribute("data-siyuan-conversation-role",turn.role);
        const heading = document.createElement("h2");
        heading.textContent = turn.role === "user"
            ? siyuanGetMessage("conversation_user")
            : siyuanGetMessage("conversation_assistant");
        const body = document.createElement("div");
        body.innerHTML = turn.content;
        section.append(heading,body);
        wrapper.appendChild(section);
    });
    return {adapter:adapter.name,turns,element:wrapper};
}

const siyuanGetReadability = async (tabId, mode = "article") => {
    try {
        chrome.i18n.getMessage("tip_clipping");
    } catch (e) {
        await siyuanLangReady;
        const shouldRefresh = confirm(siyuanGetMessage("tip_first_time"));
        if (shouldRefresh) {
            window.location.reload();
        }
    }

    const clipSettings = await siyuanEnsureClipReady();
    if (!clipSettings) {
        return;
    }

    void siyuanShowTipByKey("tip_clipping");

    try {
        // 处理 MathJax 公式 https://github.com/siyuan-note/siyuan/issues/13543
        await setMathJaxDataFormula();

        // 浏览器剪藏扩展剪藏某些网页代码块丢失注释 https://github.com/siyuan-note/siyuan/issues/5676
        document.querySelectorAll(".hljs-comment").forEach((item) => {
            item.classList.remove("hljs-comment");
            item.classList.add("hljs-cmt");
        });

        // 重构并合并 Readability 前处理 https://github.com/siyuan-note/siyuan/issues/13306
        await siyuanPrepareYuqueCards(document);
        const conversation = mode === "conversation" ? siyuanExtractConversation() : null;
        if (mode === "conversation" && !conversation) {
            void siyuanShowTipByKey("tip_conversation_not_supported", 6000);
            return;
        }
        const clonedDoc = mode === "dom" ? siyuanCreateFullDOMClone() : await siyuanGetCloneNode(document);
        siyuanCleanZhihu(clonedDoc, document.URL);
        const yuqueImageSources = mode === "dom" ? [] : siyuanPrepareYuqueImages(document, clonedDoc);
        siyuanNormalizeYuqueCodeBlocks(clonedDoc);

        let article;
        const tempElement = document.createElement("div");
        if (conversation) {
            article = {
                title: document.title || conversation.adapter + " conversation",
                siteName: conversation.adapter,
                excerpt: conversation.turns.length + " messages",
                content: conversation.element.innerHTML,
            };
            tempElement.appendChild(conversation.element);
        } else if (mode === "dom") {
            article = {
                title: document.title || location.hostname,
                siteName: location.hostname,
                excerpt: (document.body.innerText || "").trim().slice(0,240),
                content: clonedDoc.body.innerHTML,
            };
            tempElement.innerHTML = clonedDoc.body.innerHTML;
        } else {
            article = new Readability(clonedDoc, {
                keepClasses: true,
                charThreshold: 16,
                debug: true,
            }).parse();
            if (!article?.content) {
                void siyuanShowTipByKey("tip_readability_failed", 7000);
                return;
            }
            tempElement.innerHTML = article.content;
        }
        siyuanRestoreYuqueImages(tempElement, yuqueImageSources);
        // Keep structural containers so the kernel can convert separate page blocks into separate SiYuan blocks.
        simplifyNestedTags(tempElement, "SPAN");
        // console.log(article)
        siyuanSendUpload(tempElement, tabId, undefined, "article", article, window.location.href, clipSettings);
    } catch (e) {
        console.error(e);
        siyuanShowTip(e.message, undefined, 7 * 1000);
    }
};
