// Background script for handling screenshot capture and processing

class ScreenshotCapture {
    constructor() {
        this.isCapturing = false;
    }

    async captureScreenshot(tabId, options, fullPage = true) {
        if (this.isCapturing) {
            throw new Error('Screenshot capture already in progress');
        }

        this.isCapturing = true;
        
        try {
            // Step 1: Prepare the page
            await this.preparePage(tabId, options);
            
            if (fullPage) {
                // Step 2: Capture full page in segments
                const images = await this.captureFullPage(tabId, options);
                
                // Step 3: Combine images and create output
                const result = await this.processImages(images, options);
                
                return result;
            } else {
                // Step 2: Capture visible area only
                const image = await this.captureVisibleArea(tabId, options);
                
                // Step 3: Process single image
                const result = await this.processSingleImage(image, options);
                
                return result;
            }
        } finally {
            this.isCapturing = false;
        }
    }

    async preparePage(tabId, options) {
        // Inject content script to prepare the page
        await chrome.scripting.executeScript({
            target: { tabId: tabId },
            function: this.preparePageContent,
            args: [options]
        });
    }

    preparePageContent(options) {
        // This function will be executed in content script context where document is available
        // The actual implementation is in content.js
        return window.screenshotHelper ? window.screenshotHelper.prepareForScreenshot(options) : Promise.resolve();
    }

    async captureFullPage(tabId, options) {
        // Get page dimensions
        const pageInfo = await chrome.scripting.executeScript({
            target: { tabId: tabId },
            function: () => {
                return window.screenshotHelper ? window.screenshotHelper.getPageDimensions() : {
                    scrollWidth: Math.max(
                        document.documentElement.scrollWidth,
                        document.body.scrollWidth
                    ),
                    scrollHeight: Math.max(
                        document.documentElement.scrollHeight,
                        document.body.scrollHeight
                    ),
                    viewportWidth: window.innerWidth,
                    viewportHeight: window.innerHeight
                };
            }
        });

        const { scrollWidth, scrollHeight, viewportWidth, viewportHeight } = pageInfo[0].result;
        
        // Calculate number of segments needed
        const segmentsX = Math.ceil(scrollWidth / viewportWidth);
        const segmentsY = Math.ceil(scrollHeight / viewportHeight);
        const totalSegments = segmentsX * segmentsY;

        const images = [];
        let segmentIndex = 0;

        // Rate limiting based on capture speed setting
        let RATE_LIMIT_DELAY = 500; // Default: 500ms between calls = 2 calls per second
        
        switch (options.captureSpeed) {
            case 'slow':
                RATE_LIMIT_DELAY = 1000; // 1 second between calls = 1 call per second
                break;
            case 'medium':
                RATE_LIMIT_DELAY = 500; // 500ms between calls = 2 calls per second
                break;
            case 'fast':
                RATE_LIMIT_DELAY = 200; // 200ms between calls = 5 calls per second (may hit limits)
                break;
        }

        // Capture each segment
        for (let y = 0; y < segmentsY; y++) {
            for (let x = 0; x < segmentsX; x++) {
                // Scroll to position
                await chrome.scripting.executeScript({
                    target: { tabId: tabId },
                    function: (x, y, viewportWidth, viewportHeight) => {
                        window.scrollTo(
                            x * viewportWidth,
                            y * viewportHeight
                        );
                    },
                    args: [x, y, viewportWidth, viewportHeight]
                });

                // Wait for scroll to complete and add extra delay for rate limiting
                await new Promise(resolve => setTimeout(resolve, 200));

                try {
                    // Capture screenshot with retry logic
                    const screenshot = await this.captureScreenshotWithRetry(options);

                    images.push({
                        dataUrl: screenshot,
                        x: x,
                        y: y,
                        width: viewportWidth,
                        height: viewportHeight
                    });

                    segmentIndex++;
                    
                    // Update progress
                    const progress = Math.round((segmentIndex / totalSegments) * 80) + 20;
                    this.updateProgress(progress);
                    this.updateStatus(`Captured segment ${segmentIndex}/${totalSegments}`, 'info');

                    // Rate limiting delay between captures
                    if (segmentIndex < totalSegments) {
                        await new Promise(resolve => setTimeout(resolve, RATE_LIMIT_DELAY));
                    }

                } catch (error) {
                    console.error('Screenshot capture error:', error);
                    this.updateStatus(`Error capturing segment: ${error.message}`, 'error');
                    throw error;
                }
            }
        }

        return images;
    }

    async captureVisibleArea(tabId, options) {
        // Capture only the visible area with retry logic
        return await this.captureScreenshotWithRetry(options);
    }

    async processImages(images, options) {
        this.updateProgress(85);
        this.updateStatus('Processing images...', 'info');

        if (options.format === 'pdf') {
            return await this.createPDF(images, options);
        } else {
            return await this.combineImages(images, options);
        }
    }

    async processSingleImage(image, options) {
        this.updateProgress(85);
        this.updateStatus('Processing image...', 'info');

        if (options.format === 'pdf') {
            return await this.createSingleImagePDF(image, options);
        } else {
            return await this.saveSingleImage(image, options);
        }
    }

    async createPDF(images, options) {
        // Execute image processing in content script context
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        
        console.log('Executing processImagesForPDF in content script...');
        const result = await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            function: (images, options) => {
                try {
                    console.log('processImagesForPDF called with:', { imagesCount: images.length, options });
                    
                    // Validate inputs
                    if (!images || images.length === 0) {
                        console.error('No images provided to processImagesForPDF');
                        return null;
                    }

                    // Create canvas to combine images
                    const canvas = document.createElement('canvas');
                    const ctx = canvas.getContext('2d');

                    // Calculate total dimensions
                    const maxX = Math.max(...images.map(img => img.x));
                    const maxY = Math.max(...images.map(img => img.y));
                    const totalWidth = (maxX + 1) * images[0].width;
                    const totalHeight = (maxY + 1) * images[0].height;

                    console.log('Canvas dimensions:', { totalWidth, totalHeight, maxX, maxY });

                    canvas.width = totalWidth;
                    canvas.height = totalHeight;

                    // Draw images on canvas synchronously since they're already data URLs
                    for (let i = 0; i < images.length; i++) {
                        const image = images[i];
                        console.log(`Processing image ${i + 1}/${images.length}:`, { x: image.x, y: image.y, width: image.width, height: image.height });
                        
                        const img = new Image();
                        img.src = image.dataUrl;
                        // Since these are data URLs from chrome.tabs.captureVisibleTab, they should load immediately
                        ctx.drawImage(
                            img,
                            image.x * image.width,
                            image.y * image.height,
                            image.width,
                            image.height
                        );
                    }

                    // Convert canvas to data URL
                    const combinedImageDataUrl = canvas.toDataURL('image/png', options.quality);
                    console.log('Successfully created combined image data URL, length:', combinedImageDataUrl.length);

                    return {
                        combinedImageDataUrl,
                        dimensions: { width: totalWidth, height: totalHeight }
                    };
                } catch (error) {
                    console.error('Error in processImagesForPDF:', error);
                    console.error('Error stack:', error.stack);
                    return null;
                }
            },
            args: [images, options]
        });

        console.log('Result from content script:', result);

        if (!result[0] || !result[0].result) {
            console.error('Content script returned null or undefined result');
            throw new Error('Failed to process images for PDF');
        }

        const { combinedImageDataUrl, dimensions } = result[0].result;

        // For now, save as PNG instead of PDF to avoid import issues
        const filename = `screenshot_${new Date().toISOString().slice(0, 19).replace(/:/g, '-')}.png`;
        
        await chrome.downloads.download({
            url: combinedImageDataUrl,
            filename: filename,
            saveAs: true
        });

        this.updateProgress(100);
        this.updateStatus('Screenshot saved successfully!', 'success');

        return { success: true, filename: filename };
    }

    async createSingleImagePDF(image, options) {
        // Execute image processing in content script context
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        
        const result = await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            function: (image, options) => {
                try {
                    const img = new Image();
                    img.src = image;
                    
                    return {
                        imageDataUrl: image,
                        dimensions: { width: img.width, height: img.height }
                    };
                } catch (error) {
                    console.error('Error in processSingleImageForPDF:', error);
                    return null;
                }
            },
            args: [image, options]
        });

        if (!result[0] || !result[0].result) {
            throw new Error('Failed to process single image for PDF');
        }

        const { imageDataUrl, dimensions } = result[0].result;

        // For now, save as PNG instead of PDF to avoid import issues
        const filename = `screenshot_${new Date().toISOString().slice(0, 19).replace(/:/g, '-')}.png`;
        
        await chrome.downloads.download({
            url: imageDataUrl,
            filename: filename,
            saveAs: true
        });

        this.updateProgress(100);
        this.updateStatus('Screenshot saved successfully!', 'success');

        return { success: true, filename: filename };
    }

    async combineImages(images, options) {
        // Execute image processing in content script context
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        
        const result = await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            function: (images, options) => {
                try {
                    // Create canvas to combine images
                    const canvas = document.createElement('canvas');
                    const ctx = canvas.getContext('2d');

                    const maxX = Math.max(...images.map(img => img.x));
                    const maxY = Math.max(...images.map(img => img.y));
                    const totalWidth = (maxX + 1) * images[0].width;
                    const totalHeight = (maxY + 1) * images[0].height;

                    canvas.width = totalWidth;
                    canvas.height = totalHeight;

                    // Draw images on canvas synchronously since they're already data URLs
                    for (const image of images) {
                        const img = new Image();
                        img.src = image.dataUrl;
                        // Since these are data URLs from chrome.tabs.captureVisibleTab, they should load immediately
                        ctx.drawImage(
                            img,
                            image.x * image.width,
                            image.y * image.height,
                            image.width,
                            image.height
                        );
                    }

                    const combinedImageDataUrl = canvas.toDataURL(`image/${options.format}`, options.quality);
                    const filename = `screenshot_${new Date().toISOString().slice(0, 19).replace(/:/g, '-')}.${options.format}`;

                    return { combinedImageDataUrl, filename };
                } catch (error) {
                    console.error('Error in combineImagesInContent:', error);
                    return null;
                }
            },
            args: [images, options]
        });

        if (!result[0] || !result[0].result) {
            throw new Error('Failed to combine images');
        }

        const { combinedImageDataUrl, filename } = result[0].result;
        
        await chrome.downloads.download({
            url: combinedImageDataUrl,
            filename: filename,
            saveAs: true
        });

        this.updateProgress(100);
        this.updateStatus('Image saved successfully!', 'success');

        return { success: true, filename: filename };
    }

    async saveSingleImage(image, options) {
        const filename = `screenshot_${new Date().toISOString().slice(0, 19).replace(/:/g, '-')}.${options.format}`;
        
        await chrome.downloads.download({
            url: image,
            filename: filename,
            saveAs: true
        });

        this.updateProgress(100);
        this.updateStatus('Image saved successfully!', 'success');

        return { success: true, filename: filename };
    }





    // Helper method for rate-limited screenshot capture
    async captureScreenshotWithRetry(options, maxRetries = 3) {
        let screenshot = null;
        let retryCount = 0;

        while (!screenshot && retryCount < maxRetries) {
            try {
                screenshot = await chrome.tabs.captureVisibleTab(null, {
                    format: 'png',
                    quality: Math.round(options.quality * 100)
                });
            } catch (error) {
                retryCount++;
                if (error.message.includes('MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND')) {
                    // Wait longer if we hit rate limit
                    const waitTime = Math.min(1000 * retryCount, 3000); // Exponential backoff, max 3 seconds
                    await new Promise(resolve => setTimeout(resolve, waitTime));
                    this.updateStatus(`Rate limited, retrying... (${retryCount}/${maxRetries})`, 'info');
                } else {
                    throw error;
                }
            }
        }

        if (!screenshot) {
            throw new Error('Failed to capture screenshot after multiple retries');
        }

        return screenshot;
    }

    updateProgress(progress) {
        chrome.runtime.sendMessage({
            action: 'updateProgress',
            progress: progress
        });
    }

    updateStatus(message, type) {
        chrome.runtime.sendMessage({
            action: 'updateStatus',
            message: message,
            type: type
        });
    }
}

// Initialize screenshot capture instance
const screenshotCapture = new ScreenshotCapture();

// Message listener
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.action === 'captureScreenshot') {
        screenshotCapture.captureScreenshot(
            message.tabId,
            message.options,
            message.fullPage
        ).then(result => {
            sendResponse(result);
        }).catch(error => {
            sendResponse({ success: false, error: error.message });
        });
        
        return true; // Keep message channel open for async response
    }
});
