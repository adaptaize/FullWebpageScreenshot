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
        try {
            // Inject content script to prepare the page
            await chrome.scripting.executeScript({
                target: { tabId: tabId },
                function: this.preparePageContent,
                args: [options]
            });
        } catch (error) {
            console.warn('Failed to prepare page, continuing without preparation:', error);
            // Continue without page preparation if it fails
        }
    }

    preparePageContent(options) {
        // This function will be executed in content script context where document is available
        // The actual implementation is in content.js
        return window.screenshotHelper ? window.screenshotHelper.prepareForScreenshot(options) : Promise.resolve();
    }

    async captureFullPage(tabId, options) {
        // Get page dimensions
        let pageInfo;
        try {
            pageInfo = await chrome.scripting.executeScript({
                target: { tabId: tabId },
                function: () => {
                    return window.screenshotHelper ? window.screenshotHelper.getPageDimensions() : {
                        scrollWidth: Math.max(
                            document.documentElement.scrollWidth,
                            document.body.scrollWidth,
                            document.documentElement.offsetWidth,
                            document.body.offsetWidth
                        ),
                        scrollHeight: Math.max(
                            document.documentElement.scrollHeight,
                            document.body.scrollHeight,
                            document.documentElement.offsetHeight,
                            document.body.offsetHeight
                        ),
                        viewportWidth: window.innerWidth,
                        viewportHeight: window.innerHeight,
                        devicePixelRatio: window.devicePixelRatio || 1
                    };
                }
            });
        } catch (error) {
            console.error('Failed to get page dimensions:', error);
            throw new Error('Unable to access page dimensions. Please ensure the page is fully loaded.');
        }

        if (!pageInfo || !pageInfo[0] || !pageInfo[0].result) {
            throw new Error('Failed to retrieve page dimensions');
        }

        const { scrollWidth, scrollHeight, viewportWidth, viewportHeight } = pageInfo[0].result;
        
        // Calculate number of segments needed with proper boundary handling
        // Use floor to avoid creating extra segments that would cause overlaps
        const segmentsX = Math.max(1, Math.floor(scrollWidth / viewportWidth) + (scrollWidth % viewportWidth > 0 ? 1 : 0));
        const segmentsY = Math.max(1, Math.floor(scrollHeight / viewportHeight) + (scrollHeight % viewportHeight > 0 ? 1 : 0));
        const totalSegments = segmentsX * segmentsY;
        
        console.log(`Page dimensions: ${scrollWidth}x${scrollHeight}, Viewport: ${viewportWidth}x${viewportHeight}`);
        console.log(`Segments needed: ${segmentsX}x${segmentsY} = ${totalSegments} total`);
        console.log(`Remainder: X=${scrollWidth % viewportWidth}, Y=${scrollHeight % viewportHeight}`);

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
                // Calculate precise scroll position to avoid overlaps
                const scrollX = Math.min(x * viewportWidth, Math.max(0, scrollWidth - viewportWidth));
                const scrollY = Math.min(y * viewportHeight, Math.max(0, scrollHeight - viewportHeight));
                
                // Calculate actual segment dimensions (last segments might be smaller)
                const actualWidth = Math.min(viewportWidth, scrollWidth - scrollX);
                const actualHeight = Math.min(viewportHeight, scrollHeight - scrollY);
                
                console.log(`Capturing segment (${x}, ${y}) at scroll position (${scrollX}, ${scrollY}) with dimensions ${actualWidth}x${actualHeight}`);
                
                // Scroll to position with better synchronization
                try {
                    await chrome.scripting.executeScript({
                        target: { tabId: tabId },
                        function: (scrollX, scrollY) => {
                            return new Promise((resolve) => {
                                window.scrollTo(scrollX, scrollY);
                                
                                // Wait for scroll to actually complete
                                const checkScroll = () => {
                                    if (Math.abs(window.scrollX - scrollX) < 5 && Math.abs(window.scrollY - scrollY) < 5) {
                                        resolve();
                                    } else {
                                        setTimeout(checkScroll, 50);
                                    }
                                };
                                
                                // Start checking after a short delay
                                setTimeout(checkScroll, 100);
                            });
                        },
                        args: [scrollX, scrollY]
                    });
                } catch (error) {
                    console.warn(`Failed to scroll to position (${scrollX}, ${scrollY}):`, error);
                    // Continue with capture even if scroll fails
                }

                // Additional wait to ensure page is stable
                await new Promise(resolve => setTimeout(resolve, 500));

                try {
                    // Add a small delay to ensure page is fully stable
                    await new Promise(resolve => setTimeout(resolve, 200));
                    
                    // Capture screenshot with retry logic
                    const screenshot = await this.captureScreenshotWithRetry(options);

                    // Validate screenshot data
                    if (!screenshot || !screenshot.startsWith('data:image/')) {
                        throw new Error(`Invalid screenshot data received for segment (${x}, ${y})`);
                    }

                    // Check for duplicate segments
                    const existingSegment = images.find(img => img.x === x && img.y === y);
                    if (existingSegment) {
                        console.warn(`Duplicate segment detected at (${x}, ${y}), skipping...`);
                        continue;
                    }
                    
                    // Add timestamp to help identify any remaining issues
                    const timestamp = Date.now();

                    images.push({
                        dataUrl: screenshot,
                        x: x,
                        y: y,
                        width: actualWidth,
                        height: actualHeight,
                        timestamp: timestamp
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

        // Final validation
        const expectedSegments = segmentsX * segmentsY;
        if (images.length !== expectedSegments) {
            console.warn(`Expected ${expectedSegments} segments but captured ${images.length}. This might indicate some segments were skipped.`);
        }
        
        // Sort images by position for consistent processing
        images.sort((a, b) => {
            if (a.y !== b.y) return a.y - b.y;
            return a.x - b.x;
        });
        
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
        const processResult = await chrome.scripting.executeScript({
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

        console.log('Result from content script:', processResult);

        if (!processResult[0] || !processResult[0].result) {
            console.error('Content script execution failed - no result returned');
            throw new Error('Failed to process images for PDF - no result returned');
        }

        const resultData = processResult[0].result;
        
        // Check if the result contains an error
        if (resultData.error) {
            console.error('Content script returned error:', resultData.error);
            throw new Error(`Failed to process images for PDF: ${resultData.error}`);
        }

        if (!resultData.combinedImageDataUrl || !resultData.dimensions) {
            throw new Error('Content script returned invalid result - missing image data or dimensions');
        }

        const { combinedImageDataUrl, dimensions } = resultData;

        // Generate PDF from the combined image
        const pdfResult = await this.generateAndDownloadPDF(combinedImageDataUrl, dimensions, options);

        this.updateProgress(100);

        return pdfResult;
    }

    async createSingleImagePDF(image, options) {
        // Execute image processing in content script context
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        
        const singleImageResult = await chrome.scripting.executeScript({
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

        if (!singleImageResult[0] || !singleImageResult[0].result) {
            throw new Error('Failed to process single image for PDF');
        }

        const { imageDataUrl, dimensions } = singleImageResult[0].result;

        // Generate PDF from the single image
        const singlePdfResult = await this.generateAndDownloadPDF(imageDataUrl, dimensions, options);

        this.updateProgress(100);

        return singlePdfResult;
    }

    // Generate and download PDF from image data URL
    async generateAndDownloadPDF(imageDataUrl, dimensions, options) {
        try {
            // Use content script to create the PDF tab since URL.createObjectURL is not available in service workers
            const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
            
            const result = await chrome.scripting.executeScript({
                target: { tabId: tab.id },
                function: (imageDataUrl, options) => {
                    try {
                        // Create HTML content for PDF
                        const pageSize = options.pdfPageSize || 'a4';
                        const orientation = options.pdfOrientation || 'portrait';
                        
                        const htmlContent = `<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <title>Screenshot PDF</title>
    <style>
        @page {
            size: ${pageSize} ${orientation};
            margin: 0.5in;
        }
        body {
            margin: 0;
            padding: 0;
            display: flex;
            justify-content: center;
            align-items: center;
            min-height: 100vh;
            background: white;
        }
        img {
            max-width: 100%;
            max-height: 100%;
            object-fit: contain;
        }
        .instruction {
            position: fixed;
            top: 10px;
            left: 10px;
            background: #4CAF50;
            color: white;
            padding: 10px;
            border-radius: 5px;
            font-family: Arial, sans-serif;
            z-index: 1000;
        }
    </style>
</head>
<body>
    <div class="instruction">Press Ctrl+P (Cmd+P on Mac) to save as PDF</div>
    <img src="${imageDataUrl}" alt="Screenshot" />
</body>
</html>`;
                        
                        // Create blob and URL in content script context
                        const blob = new Blob([htmlContent], { type: 'text/html' });
                        const blobUrl = URL.createObjectURL(blob);
                        
                        // Open new tab with the blob URL
                        window.open(blobUrl, '_blank');
                        
                        // Clean up after a delay
                        setTimeout(() => {
                            URL.revokeObjectURL(blobUrl);
                        }, 2000);
                        
                        return { success: true };
                    } catch (error) {
                        console.error('Error in PDF generation script:', error);
                        return { success: false, error: error.message };
                    }
                },
                args: [imageDataUrl, options]
            });
            
            this.updateStatus('PDF tab opened. Use Ctrl+P (Cmd+P on Mac) to save as PDF.', 'info');
            
            return { success: true, filename: 'PDF' };
            
        } catch (error) {
            console.error('Error generating PDF:', error);
            throw new Error(`Failed to open PDF tab: ${error.message}`);
        }
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
        try {
            chrome.runtime.sendMessage({
                action: 'updateProgress',
                progress: progress
            }).catch(error => {
                console.warn('Failed to send progress update:', error);
            });
        } catch (error) {
            console.warn('Failed to send progress update:', error);
        }
    }

    updateStatus(message, type) {
        try {
            chrome.runtime.sendMessage({
                action: 'updateStatus',
                message: message,
                type: type
            }).catch(error => {
                console.warn('Failed to send status update:', error);
            });
        } catch (error) {
            console.warn('Failed to send status update:', error);
        }
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
            try {
                sendResponse(result);
            } catch (error) {
                console.warn('Failed to send response:', error);
            }
        }).catch(error => {
            try {
                sendResponse({ success: false, error: error.message });
            } catch (responseError) {
                console.warn('Failed to send error response:', responseError);
            }
        });
        
        return true; // Keep message channel open for async response
    }
    
    // Handle other messages if needed
    return false;
});
