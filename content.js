// Content script for webpage screenshot functionality

class PageScreenshotHelper {
    constructor() {
        this.originalStyles = new Map();
        this.injectedElements = [];
    }

    // Prepare page for screenshot capture
    prepareForScreenshot(options = {}) {
        this.hideScrollbars(options.hideScrollbar);
        this.waitForImages(options.waitForImages);
        this.cleanupPage(options);
    }

    // Hide scrollbars if requested
    hideScrollbars(hide = true) {
        if (!hide) return;

        const style = document.createElement('style');
        style.id = 'screenshot-extension-scrollbar-hide';
        style.textContent = `
            * {
                scrollbar-width: none !important;
                -ms-overflow-style: none !important;
            }
            *::-webkit-scrollbar {
                display: none !important;
            }
            html, body {
                overflow: hidden !important;
            }
        `;
        
        document.head.appendChild(style);
        this.injectedElements.push(style);
    }

    // Wait for all images to load
    async waitForImages(wait = true) {
        if (!wait) return;

        const images = document.querySelectorAll('img');
        if (images.length === 0) return;

        const imagePromises = Array.from(images).map(img => {
            if (img.complete) {
                return Promise.resolve();
            }
            
            return new Promise((resolve) => {
                img.addEventListener('load', resolve, { once: true });
                img.addEventListener('error', resolve, { once: true });
                
                // Timeout after 5 seconds
                setTimeout(resolve, 5000);
            });
        });

        await Promise.all(imagePromises);
    }

    // Clean up page elements that might interfere with screenshot
    cleanupPage(options = {}) {
        // Remove floating elements that might overlap
        const floatingElements = document.querySelectorAll(
            '.tooltip, .popup, .modal, .dropdown, .notification, [style*="position: fixed"], [style*="position:fixed"]'
        );

        floatingElements.forEach(element => {
            if (element.style.display !== 'none') {
                this.originalStyles.set(element, element.style.display);
                element.style.display = 'none';
            }
        });

        // Hide any auto-playing videos or animations
        const mediaElements = document.querySelectorAll('video, audio');
        mediaElements.forEach(element => {
            if (element.autoplay) {
                element.pause();
                element.style.opacity = '0';
            }
        });
    }

    // Get page dimensions
    getPageDimensions() {
        return {
            scrollWidth: Math.max(
                document.documentElement.scrollWidth,
                document.body.scrollWidth
            ),
            scrollHeight: Math.max(
                document.documentElement.scrollHeight,
                document.body.scrollHeight
            ),
            viewportWidth: window.innerWidth,
            viewportHeight: window.innerHeight,
            devicePixelRatio: window.devicePixelRatio || 1
        };
    }

    // Scroll to specific position
    scrollTo(x, y) {
        window.scrollTo(x, y);
        return new Promise(resolve => {
            // Wait for scroll to complete
            setTimeout(resolve, 100);
        });
    }

    // Restore original page state
    restorePage() {
        // Remove injected styles
        this.injectedElements.forEach(element => {
            if (element.parentNode) {
                element.parentNode.removeChild(element);
            }
        });
        this.injectedElements = [];

        // Restore original styles
        this.originalStyles.forEach((originalStyle, element) => {
            element.style.display = originalStyle;
        });
        this.originalStyles.clear();

        // Restore media elements
        const mediaElements = document.querySelectorAll('video, audio');
        mediaElements.forEach(element => {
            element.style.opacity = '';
        });
    }

    // Check if page is ready for screenshot
    isPageReady() {
        return new Promise((resolve) => {
            // Check if page is fully loaded
            if (document.readyState === 'complete') {
                resolve(true);
            } else {
                window.addEventListener('load', () => resolve(true), { once: true });
                // Timeout after 10 seconds
                setTimeout(() => resolve(true), 10000);
            }
        });
    }

    // Optimize page for better screenshot quality
    optimizeForScreenshot() {
        // Ensure proper font rendering
        document.body.style.webkitFontSmoothing = 'antialiased';
        document.body.style.mozOsxFontSmoothing = 'grayscale';
        
        // Disable any CSS animations during capture
        const style = document.createElement('style');
        style.id = 'screenshot-extension-optimize';
        style.textContent = `
            *, *::before, *::after {
                animation: none !important;
                transition: none !important;
            }
        `;
        document.head.appendChild(style);
        this.injectedElements.push(style);
    }
}

// Create global instance
window.screenshotHelper = new PageScreenshotHelper();

// Listen for messages from background script
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    switch (message.action) {
        case 'preparePage':
            window.screenshotHelper.prepareForScreenshot(message.options);
            sendResponse({ success: true });
            break;
            
        case 'getPageDimensions':
            const dimensions = window.screenshotHelper.getPageDimensions();
            sendResponse({ success: true, dimensions });
            break;
            
        case 'scrollTo':
            window.screenshotHelper.scrollTo(message.x, message.y)
                .then(() => sendResponse({ success: true }))
                .catch(error => sendResponse({ success: false, error: error.message }));
            return true; // Keep message channel open
            
        case 'restorePage':
            window.screenshotHelper.restorePage();
            sendResponse({ success: true });
            break;
            
        case 'optimizePage':
            window.screenshotHelper.optimizeForScreenshot();
            sendResponse({ success: true });
            break;
            
        case 'isPageReady':
            window.screenshotHelper.isPageReady()
                .then(ready => sendResponse({ success: true, ready }))
                .catch(error => sendResponse({ success: false, error: error.message }));
            return true; // Keep message channel open
    }
});

// Auto-cleanup when page unloads
window.addEventListener('beforeunload', () => {
    if (window.screenshotHelper) {
        window.screenshotHelper.restorePage();
    }
});

console.log('Full Webpage Screenshot extension content script loaded');
