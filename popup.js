document.addEventListener('DOMContentLoaded', function() {
    const captureBtn = document.getElementById('captureBtn');
    const captureVisibleBtn = document.getElementById('captureVisibleBtn');
    const status = document.getElementById('status');
    const progress = document.getElementById('progress');
    const progressBar = document.getElementById('progressBar');

    function showStatus(message, type = 'info') {
        status.textContent = message;
        status.className = `status ${type}`;
        status.style.display = 'block';
    }

    function hideStatus() {
        status.style.display = 'none';
    }

    function showProgress() {
        progress.style.display = 'block';
        progressBar.style.width = '0%';
    }

    function updateProgress(percentage) {
        progressBar.style.width = `${percentage}%`;
    }

    function hideProgress() {
        progress.style.display = 'none';
    }

    function disableButtons() {
        captureBtn.disabled = true;
        captureVisibleBtn.disabled = true;
    }

    function enableButtons() {
        captureBtn.disabled = false;
        captureVisibleBtn.disabled = false;
    }

    function getOptions() {
        const format = document.getElementById('format').value;
        const options = {
            quality: parseFloat(document.getElementById('quality').value),
            format: format,
            hideScrollbar: document.getElementById('hideScrollbar').checked,
            waitForImages: document.getElementById('waitForImages').checked,
            captureSpeed: document.getElementById('captureSpeed').value
        };

        // Add PDF-specific options if PDF is selected
        if (format === 'pdf') {
            options.pdfPageSize = document.getElementById('pdfPageSize').value;
            options.pdfOrientation = document.getElementById('pdfOrientation').value;
        }

        return options;
    }

    async function captureScreenshot(fullPage = true) {
        try {
            disableButtons();
            hideStatus();
            showProgress();

            const options = getOptions();
            
            showStatus('Starting capture...', 'info');
            updateProgress(10);

            // Get the active tab
            const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
            
            if (!tab) {
                throw new Error('No active tab found');
            }

            showStatus('Preparing page for capture...', 'info');
            updateProgress(20);

            // Send message to background script to start capture
            const response = await chrome.runtime.sendMessage({
                action: 'captureScreenshot',
                tabId: tab.id,
                options: options,
                fullPage: fullPage
            });

            if (response.success) {
                showStatus('Screenshot captured successfully!', 'success');
                updateProgress(100);
                
                setTimeout(() => {
                    hideStatus();
                    hideProgress();
                }, 2000);
            } else {
                throw new Error(response.error || 'Failed to capture screenshot');
            }

        } catch (error) {
            console.error('Screenshot error:', error);
            showStatus(`Error: ${error.message}`, 'error');
            hideProgress();
        } finally {
            enableButtons();
        }
    }

    // Function to toggle PDF options visibility
    function togglePdfOptions() {
        const format = document.getElementById('format').value;
        const pdfOptions = document.getElementById('pdfOptions');
        const pdfOrientation = document.getElementById('pdfOrientation');
        
        if (format === 'pdf') {
            pdfOptions.style.display = 'block';
            pdfOrientation.style.display = 'block';
        } else {
            pdfOptions.style.display = 'none';
            pdfOrientation.style.display = 'none';
        }
    }

    // Event listeners
    captureBtn.addEventListener('click', () => captureScreenshot(true));
    captureVisibleBtn.addEventListener('click', () => captureScreenshot(false));
    
    // Add event listener for format change
    document.getElementById('format').addEventListener('change', togglePdfOptions);

    // Listen for progress updates from background script
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
        if (message.action === 'updateProgress') {
            updateProgress(message.progress);
        } else if (message.action === 'updateStatus') {
            showStatus(message.message, message.type);
        }
    });

    // Initialize
    showStatus('Ready to capture screenshots', 'info');
    setTimeout(hideStatus, 2000);
});
