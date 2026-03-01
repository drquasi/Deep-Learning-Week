// AdaptiRead Content Script - Dictionary Lookup Strategy
let isEnabled = true;
let processedNodes = new WeakSet();
let scanTimeout = null;
let activeTooltip = null;

const TOOLTIP_CSS = `
.adaptiread-highlight {
    background-image: linear-gradient(120deg, rgba(122, 199, 255, 0.3) 0%, rgba(122, 199, 255, 0.3) 100%);
    background-repeat: no-repeat;
    background-size: 100% 0.2em;
    background-position: 0 88%;
    transition: background-size 0.25s ease-in;
    cursor: help;
    border-bottom: 1px dashed #7ac7ff;
}
.adaptiread-highlight:hover {
    background-size: 100% 88%;
}
.adaptiread-tooltip {
    position: fixed;
    z-index: 1000000;
    background: rgba(255, 255, 255, 0.95);
    backdrop-filter: blur(10px);
    border-radius: 12px;
    box-shadow: 0 10px 30px rgba(0,0,0,0.15);
    padding: 16px;
    width: 280px;
    font-family: 'Inter', system-ui, -apple-system, sans-serif;
    font-size: 14px;
    color: #1a1a1b;
    border: 1px solid rgba(0,0,0,0.05);
    pointer-events: none;
    opacity: 0;
    transform: translateY(10px);
    transition: opacity 0.3s, transform 0.3s;
}
.adaptiread-tooltip.visible {
    opacity: 1;
    transform: translateY(0);
}
.adaptiread-tooltip .word {
    font-weight: 700;
    font-size: 18px;
    margin-bottom: 4px;
    color: #007bff;
    text-transform: capitalize;
}
.adaptiread-tooltip .pos {
    font-style: italic;
    color: #666;
    font-size: 12px;
    margin-bottom: 8px;
}
.adaptiread-tooltip .definition {
    line-height: 1.5;
    margin-bottom: 10px;
}
.adaptiread-tooltip .synonym {
    font-size: 12px;
    color: #00a86b;
    background: rgba(0, 168, 107, 0.1);
    padding: 2px 6px;
    border-radius: 4px;
    display: inline-block;
}
.adaptiread-loading {
    color: #999;
    font-style: italic;
}
`;

function injectStyles() {
    try {
        if (!document.head) {
            console.log('AdaptiRead: Head not ready, waiting...');
            setTimeout(injectStyles, 100);
            return;
        }
        const styleUnits = document.createElement('style');
        styleUnits.textContent = TOOLTIP_CSS;
        document.head.appendChild(styleUnits);
        console.log('AdaptiRead: Styles injected');
    } catch (e) {
        console.error('AdaptiRead: Style injection failed', e);
    }
}

function safeSendMessage(message) {
    if (!chrome.runtime?.id) return Promise.resolve(null);
    return chrome.runtime.sendMessage(message).catch(err => {
        if (!err.message.includes('Extension context invalidated')) {
            console.error('AdaptiRead Error:', err);
        }
        return null;
    });
}

chrome.storage.local.get(['enabled'], (result) => {
    console.log('AdaptiRead: Settings loaded', result);
    isEnabled = result.enabled !== false;
    if (isEnabled && chrome.runtime?.id) {
        console.log('AdaptiRead: Initializing...');
        injectStyles();
        debouncedScan();
        setupObserver();
    } else {
        console.log('AdaptiRead: Disabled or ID missing');
    }
});

function setupObserver() {
    console.log('AdaptiRead: Setting up observer');
    const observer = new MutationObserver((mutations) => {
        if (!chrome.runtime?.id) { observer.disconnect(); return; }
        let shouldScan = false;
        for (const mutation of mutations) {
            if (mutation.addedNodes.length > 0) {
                const isOurNode = Array.from(mutation.addedNodes).some(n =>
                    n.classList?.contains('adaptiread-highlight') ||
                    n.classList?.contains('adaptiread-tooltip')
                );
                if (!isOurNode) { shouldScan = true; break; }
            }
        }
        if (shouldScan) debouncedScan();
    });
    observer.observe(document.body, { childList: true, subtree: true });
}

function debouncedScan() {
    if (scanTimeout) clearTimeout(scanTimeout);
    scanTimeout = setTimeout(() => {
        if (chrome.runtime?.id) scanAndProcess();
    }, 800);
}

async function scanAndProcess() {
    if (!isEnabled || !chrome.runtime?.id) return;
    console.log('AdaptiRead: Scanning page...');

    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null, false);
    let node;
    const blockMap = new Map();

    while (node = walker.nextNode()) {
        const parent = node.parentElement;
        if (!parent || processedNodes.has(node)) continue;

        const tagName = parent.tagName;
        const forbidden = ['SCRIPT', 'STYLE', 'TEXTAREA', 'NOSCRIPT', 'CODE', 'PRE', 'INPUT', 'SELECT'];
        if (forbidden.includes(tagName) || parent.closest('.adaptiread-highlight')) continue;

        // More inclusive block detection
        const blockParent = parent.closest('p, div, h1, h2, h3, h4, h5, h6, li, td, th, blockquote, dt, dd') || parent;
        if (!blockMap.has(blockParent)) blockMap.set(blockParent, []);
        blockMap.get(blockParent).push(node);
    }

    if (blockMap.size === 0) return;
    console.log(`AdaptiRead: Analyzing ${blockMap.size} text blocks`);

    const textToAnalyzeSet = new Set();
    const blockToTextSegments = new Map(); // blockElement -> array of text segments

    blockMap.forEach((nodes, blockElement) => {
        let fullText = blockElement.innerText.trim().replace(/\s+/g, ' ');
        if (fullText.length <= 20) {
            nodes.forEach(n => processedNodes.add(n));
            return;
        }

        const segments = [];
        if (fullText.length > 1500) {
            const splitSentences = fullText.match(/[^.!?]+[.!?]?(?:\s|$)/g) || [fullText];
            splitSentences.forEach(s => {
                const trimmed = s.trim();
                if (trimmed.length > 20) segments.push(trimmed);
            });
        } else {
            segments.push(fullText);
        }

        blockToTextSegments.set(blockElement, segments);
        segments.forEach(seg => textToAnalyzeSet.add(seg));
    });

    const uniqueTexts = Array.from(textToAnalyzeSet);
    if (uniqueTexts.length === 0) return;

    console.log('AdaptiRead: Fetching analysis for', uniqueTexts.length, 'segments');
    const analysisResults = await safeSendMessage({
        type: 'ANALYZE_PAGE',
        url: window.location.href,
        sentences: uniqueTexts
    });

    if (!analysisResults) {
        console.log('AdaptiRead: No results from background');
        return;
    }

    // Now process each original block exactly once
    blockMap.forEach((nodes, blockElement) => {
        const textSegments = blockToTextSegments.get(blockElement);
        if (!textSegments) return;

        // Aggregate ALL complex words for this block from all its segments
        const allComplexWords = new Set();
        textSegments.forEach(seg => {
            let words = analysisResults[seg];
            if (words) {
                if (!Array.isArray(words)) words = Object.keys(words);
                words.forEach(w => allComplexWords.add(w));
            }
        });

        if (allComplexWords.size === 0) {
            nodes.forEach(n => processedNodes.add(n));
            return;
        }

        const wordList = Array.from(allComplexWords).sort((a, b) => b.length - a.length);
        console.log(`AdaptiRead: Highlighting ${wordList.length} unique words in block`);

        nodes.forEach(textNode => {
            if (processedNodes.has(textNode)) return;
            processedNodes.add(textNode);

            const textValue = textNode.nodeValue;
            let displaySegments = [{ type: 'text', content: textValue }];
            let changed = false;

            wordList.forEach(word => {
                const escapedWord = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                const regex = new RegExp(`\\b${escapedWord}\\b`, 'gi');
                const newDisplaySegments = [];

                displaySegments.forEach(segment => {
                    if (segment.type === 'text') {
                        let lastIndex = 0, match;
                        while ((match = regex.exec(segment.content)) !== null) {
                            changed = true;
                            if (match.index > lastIndex) {
                                newDisplaySegments.push({ type: 'text', content: segment.content.substring(lastIndex, match.index) });
                            }
                            newDisplaySegments.push({ type: 'complex', word: match[0] });
                            lastIndex = regex.lastIndex;
                        }
                        if (lastIndex < segment.content.length) {
                            newDisplaySegments.push({ type: 'text', content: segment.content.substring(lastIndex) });
                        }
                    } else {
                        newDisplaySegments.push(segment);
                    }
                });
                displaySegments = newDisplaySegments;
            });

            if (changed) {
                const fragment = document.createDocumentFragment();
                displaySegments.forEach(seg => {
                    if (seg.type === 'text') {
                        fragment.appendChild(document.createTextNode(seg.content));
                    } else {
                        const span = document.createElement('span');
                        span.className = 'adaptiread-highlight';
                        span.textContent = seg.word;
                        span.setAttribute('data-word', seg.word.toLowerCase());
                        fragment.appendChild(span);
                    }
                });
                if (textNode.parentNode) {
                    textNode.parentNode.replaceChild(fragment, textNode);
                }
            }
        });
    });
}

// Tooltip Logic
document.addEventListener('mouseover', async (e) => {
    const target = e.target.closest('.adaptiread-highlight');
    if (!target || !chrome.runtime?.id) return;

    const word = target.getAttribute('data-word');
    showTooltip(target, word);
});

document.addEventListener('mouseout', (e) => {
    if (e.target.closest('.adaptiread-highlight')) hideTooltip();
});

async function showTooltip(target, word) {
    if (activeTooltip) hideTooltip();

    activeTooltip = document.createElement('div');
    activeTooltip.className = 'adaptiread-tooltip';
    activeTooltip.innerHTML = `<div class="adaptiread-loading">Loading definition...</div>`;
    document.body.appendChild(activeTooltip);

    const rect = target.getBoundingClientRect();
    const tooltipWidth = 280; // from CSS

    // Position: Absolute logic (includes scroll)
    const scrollTop = window.pageYOffset || document.documentElement.scrollTop;
    const scrollLeft = window.pageXOffset || document.documentElement.scrollLeft;

    let left = rect.left + scrollLeft + (rect.width / 2) - (tooltipWidth / 2);
    let top = rect.top + scrollTop - 10;

    // Viewport boundary check for horizontal overflow
    if (left < 10) left = 10;
    if (left + tooltipWidth > window.innerWidth + scrollLeft - 10) left = window.innerWidth + scrollLeft - tooltipWidth - 10;

    activeTooltip.style.position = 'absolute'; // Override fixed if needed
    activeTooltip.style.top = `${top}px`;
    activeTooltip.style.left = `${left}px`;
    activeTooltip.style.transform = `translateY(-100%)`;

    requestAnimationFrame(() => activeTooltip.classList.add('visible'));

    // Fetch definition
    const data = await safeSendMessage({ type: 'GET_DEFINITION', word });
    if (!chrome.runtime?.id || !activeTooltip) return;

    if (data) {
        activeTooltip.innerHTML = `
            <div class="word">${data.word}</div>
            <div class="pos">${data.partOfSpeech}</div>
            <div class="definition">${data.definition}</div>
            ${data.synonym ? `<div class="synonym">Synonym: ${data.synonym}</div>` : ''}
        `;
    } else {
        activeTooltip.innerHTML = `<div class="definition">Definition not found for "${word}".</div>`;
    }
}

function hideTooltip() {
    if (activeTooltip) {
        const el = activeTooltip;
        el.classList.remove('visible');
        setTimeout(() => el.remove(), 300);
        activeTooltip = null;
    }
}

function preserveCase(original, simplified) {
    if (!simplified) return original;
    if (original === original.toUpperCase() && original.length > 1) return simplified.toUpperCase();
    if (original[0] === original[0].toUpperCase()) return simplified[0].toUpperCase() + simplified.slice(1).toLowerCase();
    return simplified.toLowerCase();
}
