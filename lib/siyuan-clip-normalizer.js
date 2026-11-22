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

/**
 * Normalize Zhihu and KaTeX math formulas so SiYuan's kernel recognizes data-formula reliably.
 */
function siyuanNormalizeClipMath(root) {
    if (!root?.querySelectorAll) return root;
    const ownerDocument = root.ownerDocument || root;

    // Zhihu modern math spans carry LaTeX in data-tex.
    root.querySelectorAll(".ztext-math[data-tex], [data-tex]").forEach((element) => {
        if (element.hasAttribute("data-formula")) return;
        const tex = (element.getAttribute("data-tex") || "").trim();
        if (tex) {
            element.setAttribute("data-formula", tex);
        }
    });

    // Zhihu legacy equation images (eeimg / zhihu.com/equation?tex=...).
    root.querySelectorAll('img[eeimg], img[src*="zhihu.com/equation"]').forEach((img) => {
        let tex = (img.getAttribute("alt") || "").trim();
        if (!tex) {
            const src = img.getAttribute("src") || "";
            try {
                tex = (new URL(src, "https://www.zhihu.com").searchParams.get("tex") || "").trim();
            } catch (_e) {
                tex = "";
            }
        }
        if (!tex) return;
        const span = ownerDocument.createElement("span");
        span.className = "ztext-math";
        span.setAttribute("data-formula", tex);
        span.textContent = tex;
        img.replaceWith(span);
    });

    // KaTeX elements carry original TeX inside <annotation encoding="application/x-tex">.
    root.querySelectorAll(".katex").forEach((katex) => {
        if (katex.hasAttribute("data-formula") || katex.closest("[data-formula]")) return;
        const annotation = katex.querySelector('annotation[encoding="application/x-tex"]');
        const tex = (annotation?.textContent || "").trim();
        if (tex) {
            katex.setAttribute("data-formula", tex);
        }
    });

    return root;
}

/**
 * Normalize code blocks across Medium/TowardsDataScience, Shiki, Prism, Highlight.js, etc.
 * Strips copy buttons/line-number gutters and ensures clean <pre><code> structure.
 */
function siyuanNormalizeClipCodeBlocks(root) {
    if (!root?.querySelectorAll) return root;
    const ownerDocument = root.ownerDocument || root;

    root.querySelectorAll("pre").forEach((pre) => {
        if (pre.closest("[data-formula], .katex, .ztext-math, .MathJax, mjx-container")) return;

        // Strip UI chrome inside code blocks (copy buttons, line number gutters).
        pre.querySelectorAll(
            'button, [aria-label*="Copy" i], [data-testid*="copy" i], .hljs-ln-numbers, .line-numbers-rows, .gutter, .code-copy-btn'
        ).forEach((node) => node.remove());

        const existingCode = pre.querySelector("code");
        const explicitLang = (
            existingCode?.getAttribute("data-lang") ||
            existingCode?.getAttribute("data-language") ||
            pre.getAttribute("data-lang") ||
            pre.getAttribute("data-language") ||
            ""
        ).trim().replace(/^(?:language|lang)-/i, "");
        const classLangMatch = `${existingCode?.className || ""} ${pre.className || ""}`
            .match(/(?:language|lang)-([a-z0-9_+#.-]+)/i);
        const detectedLang = (explicitLang || classLangMatch?.[1] || "").toLowerCase();
        const langClass = detectedLang && /^[a-z0-9_+#.-]+$/i.test(detectedLang) ? `language-${detectedLang}` : "";

        // If <pre> already has a single clean <code> child without <br> or block line wrappers, just ensure lang class.
        const target = existingCode || pre;
        const hasLineStructure = !!target.querySelector("br, div, p, li, tr");
        if (existingCode && !hasLineStructure) {
            if (langClass && !existingCode.className.includes(langClass)) {
                existingCode.className = `${existingCode.className} ${langClass}`.trim();
            }
            return;
        }

        // Convert <br> and block line wrappers into newline-delimited plain code text.
        const clone = target.cloneNode(true);
        clone.querySelectorAll("br").forEach((br) => br.replaceWith(ownerDocument.createTextNode("\n")));
        const blockLines = clone.querySelectorAll("div, p, li, tr");
        blockLines.forEach((line, idx) => {
            if (idx > 0 && !line.previousSibling?.nodeValue?.endsWith("\n")) {
                line.parentNode?.insertBefore(ownerDocument.createTextNode("\n"), line);
            }
        });
        const codeText = clone.textContent || "";
        const codeEl = ownerDocument.createElement("code");
        if (langClass) codeEl.className = langClass;
        codeEl.textContent = codeText;
        pre.replaceChildren(codeEl);
    });

    return root;
}

/**
 * Unwrap non-semantic <span> elements that clutter inline quotes and paragraphs in SiYuan.
 */
function siyuanUnwrapRedundantSpans(root) {
    if (!root?.querySelectorAll) return root;
    const spans = Array.from(root.querySelectorAll("span")).reverse();
    for (const span of spans) {
        if (!span.parentNode) continue;
        if (span.closest("pre, code, math, svg, [data-formula], .katex, .ztext-math, .MathJax, mjx-container")) continue;
        if (span.hasAttribute("data-formula") || span.hasAttribute("data-tex") ||
            span.hasAttribute("id") || span.hasAttribute("style") ||
            span.hasAttribute("lang") || span.hasAttribute("dir") || span.hasAttribute("title")) {
            continue;
        }
        const cls = String(span.className || "");
        if (/math|latex|katex|mjx|equation|formula|hljs|code|token/i.test(cls)) continue;
        while (span.firstChild) {
            span.parentNode.insertBefore(span.firstChild, span);
        }
        span.remove();
    }
    return root;
}
