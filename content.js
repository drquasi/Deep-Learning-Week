// content script for adaptiread
// this runs on every page the student visits
let globalLoadingIndicator = null;
let hasScannedOnThisPage = false;
let isScanningActive = false;
let isApplyingHighlights = false;
let isEnabled = true;
let scanTimeout = null;
let processedNodes = new WeakSet();

// --- UTILS ---
// helps clean up text before sending to ai or hashing
function normalizeSentence(text) {
    if (!text) return '';
    return text.toLowerCase()
        .replace(/\s+/g, ' ')
        .replace(/[^\w\s\-\'\u00C0-\u017F]/g, '')
        .trim();
}

// safer way to send messages to background script
function safeSendMessage(message) {
    if (!chrome.runtime?.id) return Promise.resolve(null);
    return chrome.runtime.sendMessage(message).catch(err => {
        // ignore errors about the extension being updated or closed
        if (!err.message.includes('Extension context invalidated')) {
            console.error('AdaptiRead Error:', err);
        }
        return null;
    });
}

// inject the tooltip styles into the page head
function injectStyles() {
    if (!document.head || document.getElementById('adaptiread-styles')) return;
    const style = document.createElement('style');
    style.id = 'adaptiread-styles';
    style.textContent = TOOLTIP_CSS;
    document.head.appendChild(style);
}

// --- UI COMPONENTS ---
// show a little popup asking if they want to simplify the page
function showAskToSimplifyPopup() {
    if (hasScannedOnThisPage || document.getElementById('adaptiread-ask-popup')) return;

    const popup = document.createElement('div');
    popup.id = 'adaptiread-ask-popup';
    popup.className = 'adaptiread-ask-popup';
    popup.innerHTML = `
        <div class="title">Simplify Reading?</div>
        <div class="desc">AdaptiRead can scan this page to highlight complex words and provide definitions.</div>
        <div class="actions">
            <button class="btn-yes">Yes, Simplify</button>
            <button class="btn-no">Not Now</button>
        </div>
    `;
    document.body.appendChild(popup);

    popup.querySelector('.btn-yes').addEventListener('click', () => {
        popup.remove();
        startAdaptiRead();
    });

    popup.querySelector('.btn-no').addEventListener('click', () => {
        hasScannedOnThisPage = true;
        popup.remove();
    });

    // remove after some time if they don't click
    setTimeout(() => { if (popup.parentElement) popup.remove(); }, 15000);
}

// show a loading spinner while ai is thinking
function showLoadingIndicator() {
    if (globalLoadingIndicator) return;
    globalLoadingIndicator = document.createElement('div');
    globalLoadingIndicator.className = 'adaptiread-global-loading';
    globalLoadingIndicator.innerHTML = `
        <div class="adaptiread-spinner"></div>
        <span>Analyzing vocabulary...</span>
    `;
    document.body.appendChild(globalLoadingIndicator);
}

// hide the spinner when done
function hideLoadingIndicator() {
    if (globalLoadingIndicator) {
        globalLoadingIndicator.remove();
        globalLoadingIndicator = null;
    }
}

// --- CORE LOGIC ---
// kickoff function for the extension logic
function startAdaptiRead(force = false) {
    if (isScanningActive && !force) return;
    if (force) {
        processedNodes = new WeakSet();
        isApplyingHighlights = false;
    }
    console.log('AdaptiRead: Starting scanning engine (force=' + force + ')...');
    hasScannedOnThisPage = true;
    isScanningActive = true;
    const existingPopup = document.getElementById('adaptiread-ask-popup');
    if (existingPopup) existingPopup.remove();

    injectStyles();
    scanAndProcess(true); // first full scan
    setupObserver();
}

// --- INIT ---
// listen for messages from background or popup
console.log('AdaptiRead: Content script loaded');
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.type === 'START_SIMPLIFY') {
        startAdaptiRead(true); // force redo it
        sendResponse({ success: true });
    } else if (msg.type === 'HIGHLIGHT_WORD') {
        // highlight a specific word (from right click)
        highlightSpecificWord(msg.word);
        sendResponse({ success: true });
    }
});

// find and highlight one specific word in the text nodes
async function highlightSpecificWord(word) {
    if (!word || !chrome.runtime?.id) return;
    const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regex = new RegExp(`\\b${escaped}\\b`, 'gi');

    // walk through all text on the page
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null, false);
    const nodesToProcess = [];
    let node;
    while (node = walker.nextNode()) {
        const parent = node.parentElement;
        if (!parent || parent.closest('.adaptiread-highlight, .adaptiread-tooltip, .adaptiread-ask-popup')) continue;
        // avoid code and scripts
        const forbidden = ['SCRIPT', 'STYLE', 'TEXTAREA', 'NOSCRIPT', 'CODE', 'PRE', 'INPUT', 'SELECT'];
        if (forbidden.includes(parent.tagName)) continue;
        if (regex.test(node.nodeValue)) nodesToProcess.push(node);
    }

    // replace text with highlight spans
    nodesToProcess.forEach(textNode => {
        let displaySegments = [{ type: 'text', content: textNode.nodeValue }];
        let changed = false;

        let lastIndex = 0, match;
        const nextDisplaySegments = [];
        const content = textNode.nodeValue;

        while ((match = regex.exec(content)) !== null) {
            changed = true;
            if (match.index > lastIndex) nextDisplaySegments.push({ type: 'text', content: content.substring(lastIndex, match.index) });
            nextDisplaySegments.push({ type: 'complex', word: match[0] });
            lastIndex = regex.lastIndex;
        }
        if (lastIndex < content.length) nextDisplaySegments.push({ type: 'text', content: content.substring(lastIndex) });

        if (changed) {
            const fragment = document.createDocumentFragment();
            nextDisplaySegments.forEach(seg => {
                if (seg.type === 'text') {
                    const tn = document.createTextNode(seg.content);
                    processedNodes.add(tn);
                    fragment.appendChild(tn);
                } else {
                    const span = document.createElement('span');
                    span.className = 'adaptiread-highlight';
                    span.textContent = seg.word;
                    span.setAttribute('data-word', seg.word.toLowerCase());
                    fragment.appendChild(span);
                }
            });
            if (textNode.parentNode) textNode.parentNode.replaceChild(fragment, textNode);
        }
    });

    attachIgnoreObserverToHighlights();
}

// watch for page changes so we can highlight new text
function setupObserver() {
    const observer = new MutationObserver((mutations) => {
        if (!chrome.runtime?.id || isApplyingHighlights || !isScanningActive) return;

        let shouldScan = false;
        for (const mutation of mutations) {
            // ignore our own popups
            if (mutation.target.closest?.('.adaptiread-tooltip, .adaptiread-ask-popup, .adaptiread-global-loading')) continue;

            const hasNewContent = Array.from(mutation.addedNodes).some(n => {
                if (n.nodeType === Node.TEXT_NODE) return n.textContent.trim().length > 5;
                if (n.nodeType === Node.ELEMENT_NODE) {
                    const isOurs = n.classList.contains('adaptiread-highlight') ||
                        n.classList.contains('adaptiread-tooltip') ||
                        n.classList.contains('adaptiread-global-loading');
                    return !isOurs && !n.querySelector?.('.adaptiread-highlight');
                }
                return false;
            });

            if (hasNewContent) {
                shouldScan = true;
                break;
            }
        }
        if (shouldScan) {
            // debounce scans so we don't lag
            if (scanTimeout) clearTimeout(scanTimeout);
            scanTimeout = setTimeout(() => scanAndProcess(false), 1000);
        }
    });
    observer.observe(document.body, { childList: true, subtree: true });
}

// main process for scanning text and applying highlights
async function scanAndProcess(isInitial = false) {
    if (isApplyingHighlights || !chrome.runtime?.id) return;

    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null, false);
    let node;
    const blockMap = new Map();

    // collect all the text blocks first
    while (node = walker.nextNode()) {
        const parent = node.parentElement;
        if (!parent || processedNodes.has(node)) continue;
        if (parent.closest('.adaptiread-highlight, .adaptiread-tooltip, .adaptiread-ask-popup')) continue;

        const tagName = parent.tagName;
        const forbidden = ['SCRIPT', 'STYLE', 'TEXTAREA', 'NOSCRIPT', 'CODE', 'PRE', 'INPUT', 'SELECT'];
        if (forbidden.includes(tagName)) continue;

        // find the closest block element like a paragraph or div
        const blockParent = parent.closest('p, div, h1, h2, h3, h4, h5, h6, li, td, th, blockquote, dt, dd, section, article, header, footer, main, aside') || parent;
        if (!blockMap.has(blockParent)) blockMap.set(blockParent, []);
        blockMap.get(blockParent).push(node);
    }

    if (blockMap.size === 0) return;

    if (isInitial) showLoadingIndicator();
    isApplyingHighlights = true;

    try {
        const textToAnalyzeSet = new Set();
        const blockToTextSegments = new Map();

        // prep text for analysis
        blockMap.forEach((nodes, block) => {
            let fullText = block.textContent.trim().replace(/\s+/g, ' ');
            if (fullText.length === 0) return;

            const segments = fullText.length > 2000 ? (fullText.match(/[^.!?]+[.!?]?(?:\s|$)/g) || [fullText]) : [fullText];
            const validSegments = segments.map(s => s.trim()).filter(s => s.length > 0);

            blockToTextSegments.set(block, validSegments);
            validSegments.forEach(seg => textToAnalyzeSet.add(seg));
        });

        const uniqueTexts = Array.from(textToAnalyzeSet);
        if (uniqueTexts.length === 0) return;

        // send the text to background to check with ai
        const analysis = await safeSendMessage({ type: 'ANALYZE_PAGE', url: window.location.href, sentences: uniqueTexts });
        if (!analysis) return;

        const normalizedAnalysis = {};
        Object.keys(analysis).forEach(k => normalizedAnalysis[normalizeSentence(k)] = analysis[k]);

        // go back and apply highlights based on results
        blockMap.forEach((nodes, block) => {
            const segments = blockToTextSegments.get(block);
            if (!segments) return;

            const words = new Set();
            segments.forEach(seg => {
                const results = normalizedAnalysis[normalizeSentence(seg)];
                if (results) (Array.isArray(results) ? results : Object.keys(results)).forEach(w => words.add(w));
            });

            if (words.size === 0) {
                nodes.forEach(n => processedNodes.add(n));
                return;
            }

            console.log(`AdaptiRead: Highlighting ${words.size} unique words in block.`);
            const sortedWords = Array.from(words).sort((a, b) => b.length - a.length);

            nodes.forEach(textNode => {
                if (processedNodes.has(textNode)) return;
                processedNodes.add(textNode);

                let displaySegments = [{ type: 'text', content: textNode.nodeValue }];
                let changed = false;

                // check for each complex word in the segment
                sortedWords.forEach(word => {
                    const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                    const regex = new RegExp(`\\b${escaped}\\b`, 'gi');
                    let nextDisplaySegments = [];
                    displaySegments.forEach(seg => {
                        if (seg.type === 'text') {
                            let lastIndex = 0, match;
                            while ((match = regex.exec(seg.content)) !== null) {
                                changed = true;
                                if (match.index > lastIndex) nextDisplaySegments.push({ type: 'text', content: seg.content.substring(lastIndex, match.index) });
                                nextDisplaySegments.push({ type: 'complex', word: match[0] });
                                lastIndex = regex.lastIndex;
                            }
                            if (lastIndex < seg.content.length) nextDisplaySegments.push({ type: 'text', content: seg.content.substring(lastIndex) });
                        } else nextDisplaySegments.push(seg);
                    });
                    displaySegments = nextDisplaySegments;
                });

                // rebuild the dom with span elements
                if (changed) {
                    const fragment = document.createDocumentFragment();
                    displaySegments.forEach(seg => {
                        if (seg.type === 'text') {
                            const tn = document.createTextNode(seg.content);
                            processedNodes.add(tn);
                            fragment.appendChild(tn);
                        } else {
                            const span = document.createElement('span');
                            span.className = 'adaptiread-highlight';
                            span.textContent = seg.word;
                            span.setAttribute('data-word', seg.word.toLowerCase());
                            fragment.appendChild(span);
                        }
                    });
                    if (textNode.parentNode) textNode.parentNode.replaceChild(fragment, textNode);
                }
            });
        });
        attachIgnoreObserverToHighlights();
    } catch (err) {
        console.error('AdaptiRead: Scan error', err);
    } finally {
        isApplyingHighlights = false;
        hideLoadingIndicator();
    }
}

// --- INTERACTION LOGIC ---
// --- INTERACTION LOGIC ---
// managing tooltip states
let activeTooltip = null;
let tooltipHideTimeout = null;
let hoverTimer = null;

// detect when human hovers over a highlighted word
document.addEventListener('mouseover', async (e) => {
    const isTooltip = e.target.closest('.adaptiread-tooltip');
    const isHighlight = e.target.closest('.adaptiread-highlight');

    if (isTooltip || isHighlight) {
        if (tooltipHideTimeout) {
            clearTimeout(tooltipHideTimeout);
            tooltipHideTimeout = null;
        }
    }

    if (!isHighlight || !chrome.runtime?.id) return;
    const target = e.target.closest('.adaptiread-highlight');
    if (activeTooltip && activeTooltip._target === target) return;

    const word = target.getAttribute('data-word');

    // pop up the tooltip
    showTooltip(target, word);

    // wait half a sec before counting it as a "discovery" hover
    if (hoverTimer) clearTimeout(hoverTimer);
    hoverTimer = setTimeout(() => {
        safeSendMessage({ type: 'LOG_INTERACTION', word, interaction: 'hover' });
    }, 500);
});

// clean up when mouse leaves
document.addEventListener('mouseout', (e) => {
    if (hoverTimer) {
        clearTimeout(hoverTimer);
        hoverTimer = null;
    }
    if (activeTooltip) {
        if (tooltipHideTimeout) clearTimeout(tooltipHideTimeout);
        tooltipHideTimeout = setTimeout(() => {
            hideTooltip();
        }, 300);
    }
});

// fetch and show word definition in a floating bubble
async function showTooltip(target, word) {
    if (activeTooltip) hideTooltip();
    activeTooltip = document.createElement('div');
    activeTooltip._target = target;
    activeTooltip.className = 'adaptiread-tooltip';
    activeTooltip.innerHTML = `<div class="adaptiread-loading">Loading definition...</div>`;
    document.body.appendChild(activeTooltip);

    // work out where to put the bubble
    const rect = target.getBoundingClientRect();
    const tooltipWidth = 280;
    const scrollTop = window.pageYOffset || document.documentElement.scrollTop;
    const scrollLeft = window.pageXOffset || document.documentElement.scrollLeft;

    let left = rect.left + scrollLeft + (rect.width / 2) - (tooltipWidth / 2);
    let top = rect.top + scrollTop - 10;
    if (left < 10) left = 10;
    if (left + tooltipWidth > window.innerWidth + scrollLeft - 10) left = window.innerWidth + scrollLeft - tooltipWidth - 10;

    activeTooltip.style.position = 'absolute';
    activeTooltip.style.top = `${top}px`;
    activeTooltip.style.left = `${left}px`;
    activeTooltip.style.transform = 'translateY(-100%)';

    requestAnimationFrame(() => { if (activeTooltip) activeTooltip.classList.add('visible'); });

    // get data from background script
    const data = await safeSendMessage({ type: 'GET_DEFINITION', word });
    if (!activeTooltip || activeTooltip._target !== target) return;

    if (data) {
        // they definitely saw the word now
        safeSendMessage({ type: 'LOG_INTERACTION', word, interaction: 'hover' });
        if (hoverTimer) {
            clearTimeout(hoverTimer);
            hoverTimer = null;
        }

        activeTooltip.innerHTML = `
            <div class="word">${data.word}</div>
            <div class="pos">${data.partOfSpeech}</div>
            <div class="definition">${data.definition}</div>
            <div class="synonym">${data.synonym ? `Synonym: ${data.synonym}` : ''}</div>
            <div class="tutor-actions" style="display: flex; gap: 8px;">
                <button class="btn-known" id="adaptiread-mark-known" style="flex: 2;">I Already Know This</button>
                <button class="btn-known" id="adaptiread-view-examples" style="flex: 1; background: #374151;">Examples</button>
            </div>
        `;

        // handle marking word as already known
        activeTooltip.querySelector('#adaptiread-mark-known').onclick = (e) => {
            e.stopPropagation();
            safeSendMessage({ type: 'LOG_INTERACTION', word: data.word, interaction: 'click' });
            safeSendMessage({ type: 'MARK_KNOWN', word: data.word });
            target.classList.add('mastered');
            setTimeout(() => target.replaceWith(target.textContent), 500);
            hideTooltip();
        };

        // switch to example sentences view
        activeTooltip.querySelector('#adaptiread-view-examples').onclick = (e) => {
            e.stopPropagation();
            safeSendMessage({ type: 'LOG_INTERACTION', word: data.word, interaction: 'click' });
            showInPageExamples(data.word, activeTooltip, data, target);
        };
    } else {
        activeTooltip.innerHTML = `<div class="definition">Definition not found.</div>`;
    }
}

// show example sentences inside the same tooltip bubble
async function showInPageExamples(word, tooltip, wordData, target, forceRefresh = false) {
    tooltip.innerHTML = `
        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px;">
            <div class="word" style="margin: 0;">Examples: ${word}</div>
            <button id="adaptiread-close-examples" style="background: none; border: none; color: #9ca3af; cursor: pointer; padding: 4px;">✕</button>
        </div>
        <div class="adaptiread-spinner" style="margin: 20px auto;"></div>
        <p style="font-size: 11px; text-align: center; color: #9ca3af;">Loading usage samples...</p>
    `;

    tooltip.querySelector('#adaptiread-close-examples').onclick = (e) => {
        e.stopPropagation();
        hideTooltip();
    };

    const content = await safeSendMessage({ type: 'GET_PRACTICE_CONTENT', word, forceRefresh });
    if (!activeTooltip || !tooltip.parentElement) return;

    if (!content || !content.sentences || content.sentences.length === 0) {
        tooltip.innerHTML = `
            <div class="word">${word}</div>
            <div class="definition">No examples found for this word.</div>
            <button id="adaptiread-error-close" class="btn-known" style="margin-top: 12px; background: #374151;">Close</button>
        `;
        tooltip.querySelector('#adaptiread-error-close').onclick = (e) => {
            e.stopPropagation();
            hideTooltip();
        };
        return;
    }

    let currentIndex = 0;
    const sentences = content.sentences;

    // render a mini flashcard for the student to review
    function renderFlashcard() {
        if (currentIndex >= sentences.length) {
            tooltip.innerHTML = `
                <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px;">
                    <div class="word" style="margin: 0;">Examples: ${word}</div>
                    <button id="adaptiread-close-end" style="background: none; border: none; color: #9ca3af; cursor: pointer; padding: 4px;">✕</button>
                </div>
                <div style="text-align: center; padding: 10px 0;">
                    <p style="font-size: 14px; color: #10b981; font-weight: 500;">Review Complete!</p>
                    <p style="font-size: 11px; color: #9ca3af; margin-top: 4px; margin-bottom: 16px;">Proficiency updated.</p>
                    <button id="adaptiread-gen-more" class="btn-known" style="background: #374151; font-size: 11px; padding: 8px;">Generate 6 More Examples</button>
                </div>
            `;
            tooltip.querySelector('#adaptiread-close-end').onclick = () => hideTooltip();
            tooltip.querySelector('#adaptiread-gen-more').onclick = (e) => {
                e.stopPropagation();
                showInPageExamples(word, tooltip, wordData, target, true);
            };
            return;
        }

        const sentence = sentences[currentIndex];
        tooltip.innerHTML = `
            <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px;">
                <div class="word" style="margin: 0;">Examples: ${word}</div>
                <button id="adaptiread-close-card" style="background: none; border: none; color: #9ca3af; cursor: pointer; padding: 4px;">✕</button>
            </div>
            <div class="pos">${wordData.partOfSpeech}</div>
            <div style="min-height: 80px; display: flex; align-items: center; margin-bottom: 16px;">
                <p style="font-size: 13px; color: #f9fafb; line-height: 1.5; border-left: 3px solid #3b82f6; padding-left: 12px; width: 100%;">${sentence}</p>
            </div>
            <div style="display: flex; gap: 8px;">
                <button id="card-understand" class="btn-known" style="background: #059669; flex: 1; font-size: 11px; padding: 8px;">Understand</button>
                <button id="card-difficult" class="btn-known" style="background: #374151; flex: 1; font-size: 11px; padding: 8px;">Difficult</button>
            </div>
            <div style="margin-top: 12px; font-size: 10px; color: #6b7280; text-align: center;">${currentIndex + 1} / ${sentences.length}</div>
        `;

        tooltip.querySelector('#adaptiread-close-card').onclick = (e) => {
            e.stopPropagation();
            hideTooltip();
        };

        tooltip.querySelector('#card-understand').onclick = (e) => {
            e.stopPropagation();
            safeSendMessage({ type: 'LOG_INTERACTION', word, interaction: 'practice_viewed' });
            currentIndex++;
            renderFlashcard();
        };

        tooltip.querySelector('#card-difficult').onclick = (e) => {
            e.stopPropagation();
            safeSendMessage({ type: 'LOG_MISUNDERSTOOD', word, sentence });
            currentIndex++;
            renderFlashcard();
        };
    }

    renderFlashcard();
}

// kill the tooltip bubble
function hideTooltip() {
    if (activeTooltip) {
        const el = activeTooltip;
        el.classList.remove('visible');
        setTimeout(() => {
            if (el.parentElement) el.remove();
        }, 300);
        activeTooltip = null;
        if (tooltipHideTimeout) {
            clearTimeout(tooltipHideTimeout);
            tooltipHideTimeout = null;
        }
    }
}

// --- PASSIVE TRACKING ---
// check if human sees words by just scrolling past them
const trackedWordsOnPage = new Set();
const ignoreObserver = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
        if (entry.isIntersecting) {
            const word = entry.target.getAttribute('data-word');
            entry.target._viewTimer = setTimeout(() => {
                if (!trackedWordsOnPage.has(word)) {
                    trackedWordsOnPage.add(word);
                    safeSendMessage({ type: 'LOG_INTERACTION', word, interaction: 'context_seen' });
                }
            }, 3000); // 3 seconds count as seen
        } else clearTimeout(entry.target._viewTimer);
    });
}, { threshold: 0.5 });

// hook up the observer to all highlight elements
function attachIgnoreObserverToHighlights() {
    document.querySelectorAll('.adaptiread-highlight').forEach(el => ignoreObserver.observe(el));
}

// --- INIT ---
// entry points for the content script
console.log('AdaptiRead: Content script loaded');
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.type === 'START_SIMPLIFY') {
        startAdaptiRead();
    }
});

chrome.storage.local.get(['enabled'], (res) => {
    isEnabled = res.enabled !== false;
    console.log('AdaptiRead: isEnabled =', isEnabled);
    if (isEnabled && chrome.runtime?.id) {
        injectStyles();
        showAskToSimplifyPopup();
    }
});

// the big bunch of css for the tooltips and highlights
const TOOLTIP_CSS = `
    .adaptiread-highlight {
        background-color: rgba(59, 130, 246, 0.2);
        border-bottom: 2px solid #3b82f6;
        cursor: help;
        transition: all 0.2s ease;
        border-radius: 2px;
        padding: 0 1px;
    }
    .adaptiread-highlight:hover { background: rgba(59, 130, 246, 0.2); }
    .adaptiread-tooltip {
        position: absolute; z-index: 2147483647; width: 280px; 
        background: #1f2937; border: 1px solid #374151; border-radius: 12px;
        padding: 20px; color: #f9fafb; font-family: 'Inter', sans-serif; 
        opacity: 0; visibility: hidden; transition: all 0.2s ease;
        box-shadow: 0 10px 25px -5px rgba(0, 0, 0, 0.1), 0 8px 10px -6px rgba(0, 0, 0, 0.1);
    }
    .adaptiread-tooltip.visible { opacity: 1; visibility: visible; }
    .adaptiread-tooltip .word { font-size: 16px; font-weight: 500; margin-bottom: 4px; color: #f9fafb; }
    .adaptiread-tooltip .pos { font-size: 10px; font-weight: 500; text-transform: uppercase; color: #3b82f6; margin-bottom: 12px; letter-spacing: 0.5px; }
    .adaptiread-tooltip .definition { font-size: 13px; line-height: 1.6; color: #9ca3af; margin-bottom: 8px; }
    .adaptiread-tooltip .synonym { font-size: 13px; color: #9ca3af; margin-bottom: 16px; font-style: italic; }
    .adaptiread-tooltip .btn-known { width: 100%; background: #3b82f6; border: none; border-radius: 6px; padding: 10px; color: white; font-size: 12px; font-weight: 500; cursor: pointer; transition: opacity 0.2s; }
    .adaptiread-tooltip .btn-known:hover { opacity: 0.9; }
    
    .adaptiread-global-loading {
        position: fixed; top: 24px; right: 24px; z-index: 2147483647;
        background: #1f2937; padding: 12px 20px; border-radius: 50px; border: 1px solid #374151;
        color: #f9fafb; display: flex; align-items: center; gap: 12px; font-size: 13px;
        box-shadow: 0 4px 12px rgba(0,0,0,0.1);
    }
    .adaptiread-spinner { width: 14px; height: 14px; border: 2px solid rgba(255,255,255,0.1); border-top-color: #3b82f6; border-radius: 50%; animation: adaptiread-spin 0.8s linear infinite; }
    @keyframes adaptiread-spin { to { transform: rotate(360deg); } }
    
    .adaptiread-ask-popup {
        position: fixed; top: 24px; right: 24px; z-index: 2147483647; width: 300px;
        background: #1f2937; padding: 24px; border-radius: 16px; border: 1px solid #374151; 
        color: #f9fafb; font-family: 'Inter', sans-serif;
        box-shadow: 0 20px 25px -5px rgba(0, 0, 0, 0.1);
        animation: adaptiread-slide-in 0.3s ease-out;
    }
    @keyframes adaptiread-slide-in {
        from { transform: translateY(-10px); opacity: 0; }
        to { transform: translateY(0); opacity: 1; }
    }
    .adaptiread-ask-popup .title { font-size: 15px; font-weight: 500; margin-bottom: 8px; }
    .adaptiread-ask-popup .desc { font-size: 13px; color: #9ca3af; margin-bottom: 18px; line-height: 1.5; }
    .adaptiread-ask-popup .actions { display: flex; gap: 8px; }
    .adaptiread-ask-popup button { flex: 1; padding: 10px; border-radius: 8px; border: none; font-weight: 500; cursor: pointer; font-size: 12px; transition: all 0.2s; }
    .adaptiread-ask-popup .btn-yes { background: #3b82f6; color: white; }
    .adaptiread-ask-popup .btn-no { background: #374151; color: #f9fafb; }
`;
