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

                    // Validate screenshot data
                    if (!screenshot || !screenshot.startsWith('data:image/')) {
                        throw new Error(`Invalid screenshot data received for segment (${x}, ${y})`);
                    }

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
                    this.updateStatus(`Error capturing segment (${x}, ${y}): ${error.message}`, 'error');
                    throw error;
                }
            }
        }

        // Validate that we have captured images
        if (images.length === 0) {
            throw new Error('No images were captured during the screenshot process');
        }

        // Validate all images have required properties
        for (let i = 0; i < images.length; i++) {
            const img = images[i];
            if (!img.dataUrl || !img.dataUrl.startsWith('data:image/')) {
                throw new Error(`Invalid image data at index ${i}`);
            }
            if (typeof img.x !== 'number' || typeof img.y !== 'number' || 
                typeof img.width !== 'number' || typeof img.height !== 'number') {
                throw new Error(`Invalid image dimensions at index ${i}`);
            }
        }

        console.log(`Successfully captured ${images.length} image segments`);
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
            function: async (images, options) => {
                try {
                    console.log('processImagesForPDF called with:', { imagesCount: images.length, options });
                    
                    // Validate inputs
                    if (!images || images.length === 0) {
                        throw new Error('No images provided to processImagesForPDF');
                    }

                    // Check for valid image data
                    for (let i = 0; i < images.length; i++) {
                        if (!images[i].dataUrl || !images[i].dataUrl.startsWith('data:image/')) {
                            throw new Error(`Invalid image data at index ${i}`);
                        }
                    }

                    // Create canvas to combine images
                    const canvas = document.createElement('canvas');
                    const ctx = canvas.getContext('2d');

                    if (!ctx) {
                        throw new Error('Failed to get canvas 2D context');
                    }

                    // Calculate total dimensions
                    const maxX = Math.max(...images.map(img => img.x));
                    const maxY = Math.max(...images.map(img => img.y));
                    const totalWidth = (maxX + 1) * images[0].width;
                    const totalHeight = (maxY + 1) * images[0].height;

                    console.log('Canvas dimensions:', { totalWidth, totalHeight, maxX, maxY });

                    // Check canvas size limits (most browsers support up to 32,767 pixels)
                    const MAX_CANVAS_SIZE = 32767;
                    let scale = 1;
                    
                    if (totalWidth > MAX_CANVAS_SIZE || totalHeight > MAX_CANVAS_SIZE) {
                        console.warn(`Canvas size too large: ${totalWidth}x${totalHeight}. Attempting to scale down...`);
                        
                        // Calculate scale factor to fit within limits
                        const scaleX = MAX_CANVAS_SIZE / totalWidth;
                        const scaleY = MAX_CANVAS_SIZE / totalHeight;
                        scale = Math.min(scaleX, scaleY, 1); // Don't scale up
                        
                        if (scale < 0.1) {
                            throw new Error(`Page too large to process. Canvas size: ${totalWidth}x${totalHeight}. Maximum supported: ${MAX_CANVAS_SIZE}x${MAX_CANVAS_SIZE}. Consider using a smaller viewport or capturing in sections.`);
                        }
                        
                        console.log(`Scaling down by factor ${scale.toFixed(3)}`);
                    }

                    canvas.width = Math.floor(totalWidth * scale);
                    canvas.height = Math.floor(totalHeight * scale);

                    // Load and draw images asynchronously
                    const imagePromises = images.map((imageData, index) => {
                        return new Promise((resolve, reject) => {
                            const img = new Image();
                            
                            img.onload = () => {
                                try {
                                    console.log(`Drawing image ${index + 1}/${images.length} at position (${imageData.x}, ${imageData.y})`);
                                    ctx.drawImage(
                                        img,
                                        imageData.x * imageData.width * scale,
                                        imageData.y * imageData.height * scale,
                                        imageData.width * scale,
                                        imageData.height * scale
                                    );
                                    resolve();
                                } catch (drawError) {
                                    console.error(`Error drawing image ${index + 1}:`, drawError);
                                    reject(drawError);
                                }
                            };
                            
                            img.onerror = (error) => {
                                console.error(`Error loading image ${index + 1}:`, error);
                                reject(new Error(`Failed to load image ${index + 1}`));
                            };
                            
                            // Set timeout for image loading
                            setTimeout(() => {
                                reject(new Error(`Timeout loading image ${index + 1}`));
                            }, 10000);
                            
                            img.src = imageData.dataUrl;
                        });
                    });

                    // Wait for all images to load and draw
                    await Promise.all(imagePromises);
                    console.log('All images drawn successfully');

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
                    return { error: error.message, stack: error.stack };
                }
            },
            args: [images, options]
        });

        console.log('Result from content script:', result);

        if (!result[0] || !result[0].result) {
            console.error('Content script execution failed - no result returned');
            throw new Error('Failed to process images for PDF - no result returned');
        }

        const resultData = result[0].result;
        
        // Check if the result contains an error
        if (resultData.error) {
            console.error('Content script returned error:', resultData.error);
            throw new Error(`Failed to process images for PDF: ${resultData.error}`);
        }

        if (!resultData.combinedImageDataUrl || !resultData.dimensions) {
            throw new Error('Content script returned invalid result - missing image data or dimensions');
        }

        const { combinedImageDataUrl, dimensions } = resultData;

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
            function: async (images, options) => {
                try {
                    console.log('Starting image combination with', images.length, 'images');
                    
                    // Validate inputs
                    if (!images || images.length === 0) {
                        throw new Error('No images provided for combination');
                    }

                    // Check for valid image data
                    for (let i = 0; i < images.length; i++) {
                        if (!images[i].dataUrl || !images[i].dataUrl.startsWith('data:image/')) {
                            throw new Error(`Invalid image data at index ${i}`);
                        }
                    }

                    // Create canvas to combine images
                    const canvas = document.createElement('canvas');
                    const ctx = canvas.getContext('2d');

                    if (!ctx) {
                        throw new Error('Failed to get canvas 2D context');
                    }

                    const maxX = Math.max(...images.map(img => img.x));
                    const maxY = Math.max(...images.map(img => img.y));
                    const totalWidth = (maxX + 1) * images[0].width;
                    const totalHeight = (maxY + 1) * images[0].height;

                    console.log('Canvas dimensions:', { totalWidth, totalHeight, maxX, maxY });

                    // Check canvas size limits (most browsers support up to 32,767 pixels)
                    const MAX_CANVAS_SIZE = 32767;
                    let scale = 1;
                    
                    if (totalWidth > MAX_CANVAS_SIZE || totalHeight > MAX_CANVAS_SIZE) {
                        console.warn(`Canvas size too large: ${totalWidth}x${totalHeight}. Attempting to scale down...`);
                        
                        // Calculate scale factor to fit within limits
                        const scaleX = MAX_CANVAS_SIZE / totalWidth;
                        const scaleY = MAX_CANVAS_SIZE / totalHeight;
                        scale = Math.min(scaleX, scaleY, 1); // Don't scale up
                        
                        if (scale < 0.1) {
                            throw new Error(`Page too large to process. Canvas size: ${totalWidth}x${totalHeight}. Maximum supported: ${MAX_CANVAS_SIZE}x${MAX_CANVAS_SIZE}. Consider using a smaller viewport or capturing in sections.`);
                        }
                        
                        console.log(`Scaling down by factor ${scale.toFixed(3)}`);
                    }

                    canvas.width = Math.floor(totalWidth * scale);
                    canvas.height = Math.floor(totalHeight * scale);

                    // Load and draw images asynchronously
                    const imagePromises = images.map((imageData, index) => {
                        return new Promise((resolve, reject) => {
                            const img = new Image();
                            
                            img.onload = () => {
                                try {
                                    console.log(`Drawing image ${index + 1}/${images.length} at position (${imageData.x}, ${imageData.y})`);
                                    ctx.drawImage(
                                        img,
                                        imageData.x * imageData.width * scale,
                                        imageData.y * imageData.height * scale,
                                        imageData.width * scale,
                                        imageData.height * scale
                                    );
                                    resolve();
                                } catch (drawError) {
                                    console.error(`Error drawing image ${index + 1}:`, drawError);
                                    reject(drawError);
                                }
                            };
                            
                            img.onerror = (error) => {
                                console.error(`Error loading image ${index + 1}:`, error);
                                reject(new Error(`Failed to load image ${index + 1}`));
                            };
                            
                            // Set timeout for image loading
                            setTimeout(() => {
                                reject(new Error(`Timeout loading image ${index + 1}`));
                            }, 10000);
                            
                            img.src = imageData.dataUrl;
                        });
                    });

                    // Wait for all images to load and draw
                    await Promise.all(imagePromises);
                    console.log('All images drawn successfully');

                    // Convert canvas to data URL
                    const combinedImageDataUrl = canvas.toDataURL(`image/${options.format}`, options.quality);
                    const filename = `screenshot_${new Date().toISOString().slice(0, 19).replace(/:/g, '-')}.${options.format}`;

                    console.log('Successfully created combined image, data URL length:', combinedImageDataUrl.length);

                    return { combinedImageDataUrl, filename };
                } catch (error) {
                    console.error('Error in combineImagesInContent:', error);
                    console.error('Error stack:', error.stack);
                    return { error: error.message, stack: error.stack };
                }
            },
            args: [images, options]
        });

        console.log('Result from content script:', result);

        if (!result[0] || !result[0].result) {
            throw new Error('Content script execution failed - no result returned');
        }

        const resultData = result[0].result;
        
        // Check if the result contains an error
        if (resultData.error) {
            throw new Error(`Failed to combine images: ${resultData.error}`);
        }

        if (!resultData.combinedImageDataUrl || !resultData.filename) {
            throw new Error('Content script returned invalid result - missing image data or filename');
        }

        const { combinedImageDataUrl, filename } = resultData;
        
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
