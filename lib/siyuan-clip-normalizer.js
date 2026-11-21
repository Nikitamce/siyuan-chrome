const SIYUAN_CLIP_BLOCK_TAGS = new Set([
    "DIV", "SECTION", "ARTICLE", "MAIN", "HEADER", "FOOTER", "ASIDE",
    "P", "H1", "H2", "H3", "H4", "H5", "H6", "UL", "OL", "LI",
    "BLOCKQUOTE", "PRE", "TABLE", "THEAD", "TBODY", "TFOOT", "TR",
    "TD", "TH", "FIGURE", "FIGCAPTION", "HR", "DL", "DT", "DD",
    "DETAILS", "SUMMARY",
]);
const SIYUAN_CLIP_IMAGE_EXTENSIONS = /\.(?:avif|bmp|gif|jpe?g|png|svg|webp)(?:$)/i;

function siyuanHasClipContent(node) {
    if (node.nodeType === 3) return !!node.nodeValue?.trim();
    if (node.nodeType !== 1) return false;
    if (["IMG", "VIDEO", "AUDIO", "IFRAME", "SVG", "CANVAS"].includes(node.tagName)) return true;
    return !!node.textContent?.trim() || !!node.querySelector?.("img,video,audio,iframe,svg,canvas");
}

function siyuanIsClipBlockNode(node) {
    return node.nodeType === 1 && SIYUAN_CLIP_BLOCK_TAGS.has(node.tagName);
}

function siyuanWrapClipInlineRuns(container, ownerDocument) {
    let run = [];
    const flush = () => {
        if (!run.length) return;
        if (run.some(siyuanHasClipContent)) {
            const paragraph = ownerDocument.createElement("p");
            container.insertBefore(paragraph, run[0]);
            run.forEach(node => paragraph.appendChild(node));
        } else {
            run.forEach(node => node.remove());
        }
        run = [];
    };
    for (const child of Array.from(container.childNodes)) {
        if (siyuanIsClipBlockNode(child)) flush();
        else run.push(child);
    }
    flush();
}

/**
 * Restore paragraph boundaries lost by sites that build posts out of nested DIVs.
 * Existing semantic blocks (paragraphs, headings, lists, quotes, tables) are kept intact.
 */
function siyuanNormalizeClipBlockStructure(root) {
    if (!root?.querySelectorAll) return root;
    const ownerDocument = root.ownerDocument || root;
    const containers = Array.from(root.querySelectorAll("div,section,article,main,header,footer,aside")).reverse();
    for (const container of containers) {
        if (!container.isConnected && container.parentNode == null) continue;
        if (container.closest("pre,code,table,svg,math,[contenteditable='true'],.katex,.hljs")) continue;
        const hasBlockChildren = Array.from(container.childNodes).some(siyuanIsClipBlockNode);
        if (container.tagName === "DIV" && !hasBlockChildren) {
            if (!siyuanHasClipContent(container)) {
                container.remove();
                continue;
            }
            const paragraph = ownerDocument.createElement("p");
            while (container.firstChild) paragraph.appendChild(container.firstChild);
            container.replaceWith(paragraph);
            continue;
        }
        siyuanWrapClipInlineRuns(container, ownerDocument);
    }
    return root;
}

/**
 * Turn bare image URLs written into post text into actual image blocks while keeping a link fallback.
 * URLs already inside links/code are left unchanged.
 */
function siyuanConvertBareClipImageURLs(root) {
    if (!root?.ownerDocument && root?.nodeType !== 9) return root;
    const ownerDocument = root.ownerDocument || root;
    const walker = ownerDocument.createTreeWalker(root, 4);
    const textNodes = [];
    while (walker.nextNode()) textNodes.push(walker.currentNode);

    const urlPattern = /https?:\/\/[^\s<>"']+/gi;
    for (const textNode of textNodes) {
        if (!textNode.parentNode || textNode.parentElement?.closest("a,code,pre,script,style")) continue;
        const value = textNode.nodeValue || "";
        urlPattern.lastIndex = 0;
        let match;
        let offset = 0;
        const fragment = ownerDocument.createDocumentFragment();
        let changed = false;
        while ((match = urlPattern.exec(value))) {
            let candidate = match[0];
            let trailing = "";
            while (/[.,!?;:)]$/.test(candidate)) {
                trailing = candidate.slice(-1) + trailing;
                candidate = candidate.slice(0, -1);
            }
            let parsed;
            try { parsed = new URL(candidate); } catch { continue; }
            if (!/^https?:$/.test(parsed.protocol) || !SIYUAN_CLIP_IMAGE_EXTENSIONS.test(parsed.pathname)) continue;

            fragment.appendChild(ownerDocument.createTextNode(value.slice(offset, match.index)));
            const link = ownerDocument.createElement("a");
            link.href = parsed.href;
            const image = ownerDocument.createElement("img");
            image.src = parsed.href;
            image.alt = "Image attachment";
            image.loading = "eager";
            image.style.maxWidth = "100%";
            image.style.height = "auto";
            link.appendChild(image);
            fragment.appendChild(link);
            if (trailing) fragment.appendChild(ownerDocument.createTextNode(trailing));
            offset = match.index + match[0].length;
            changed = true;
        }
        if (changed) {
            fragment.appendChild(ownerDocument.createTextNode(value.slice(offset)));
            textNode.replaceWith(fragment);
        }
    }
    return root;
}
