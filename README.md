# Full Webpage Screenshot Chrome Extension

A powerful Chrome extension that captures full webpage screenshots, including very long pages, and saves them as PDF files.

## Features

- 📸 **Full Page Screenshots** - Capture entire webpages by taking piece-by-piece screenshots
- 📄 **PDF Export** - Automatically combine images and save as PDF format
- 🎨 **Multiple Formats** - Support for PDF, PNG, and JPG output
- ⚙️ **Quality Settings** - High, Medium, Low quality options
- 🎯 **Smart Capture** - Hides scrollbars and waits for images to load
- 📊 **Progress Tracking** - Real-time progress updates during capture
- 🎨 **Modern UI** - Beautiful gradient design with smooth animations

## Installation

### Method 1: Load as Unpacked Extension (Development)

1. Download or clone this repository
2. Open Chrome and navigate to `chrome://extensions/`
3. Enable "Developer mode" in the top right corner
4. Click "Load unpacked" and select the extension folder
5. The extension icon will appear in your Chrome toolbar

### Method 2: Install from Chrome Web Store (Coming Soon)

*This extension will be available on the Chrome Web Store soon.*

## Usage

1. **Navigate** to any webpage you want to capture
2. **Click** the extension icon in your Chrome toolbar
3. **Choose** your preferred settings:
   - Image Quality: High (80%), Medium (60%), or Low (40%)
   - Output Format: PDF, PNG, or JPG
   - Hide scrollbars during capture
   - Wait for images to load
4. **Click** "Capture Full Page" for entire webpage or "Capture Visible Area" for current view
5. **Wait** for the capture to complete (progress bar will show status)
6. **Download** your screenshot automatically

## Technical Details

### Architecture
- **Manifest V3** - Uses latest Chrome extension standards
- **Service Worker** - Background script for processing
- **Content Scripts** - Page preparation and DOM manipulation
- **Canvas API** - Image manipulation and combining
- **jsPDF** - PDF generation

### Files Structure
```
├── manifest.json          # Extension configuration
├── popup.html            # Extension popup interface
├── popup.js              # Popup interaction logic
├── background.js         # Main screenshot processing
├── content.js            # Page preparation script
├── icons/                # Extension icons
│   ├── icon16.png
│   ├── icon48.png
│   ├── icon128.png
│   └── icon.svg
└── README.md
```

### Permissions
- `activeTab` - Access to current tab
- `scripting` - Execute scripts in tabs
- `downloads` - Save files to user's computer
- `storage` - Store extension settings
- `<all_urls>` - Work on all websites

## How It Works

1. **Page Preparation**: The extension prepares the webpage by hiding scrollbars, waiting for images to load, and optimizing for capture
2. **Segmented Capture**: For full page screenshots, it captures the page in segments by scrolling and taking multiple screenshots
3. **Image Processing**: Combines the captured segments into a single image using Canvas API
4. **PDF Generation**: Converts the combined image to PDF format using jsPDF library
5. **Download**: Automatically downloads the final file to the user's computer

## Browser Compatibility

- Chrome 88+ (Manifest V3 support)
- Edge 88+ (Chromium-based)
- Other Chromium-based browsers

## Development

### Prerequisites
- Node.js (for icon generation)
- Chrome browser

### Building Icons
If you need to regenerate the PNG icons:
```bash
node create_simple_icons.js
```

### Testing
1. Load the extension in Chrome
2. Navigate to various websites
3. Test both full page and visible area capture
4. Verify PDF generation works correctly

## Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Test thoroughly
5. Submit a pull request

## License

This project is licensed under the MIT License - see the LICENSE file for details.

## Support

If you encounter any issues or have feature requests, please open an issue on GitHub.

---

**Note**: This extension is designed to work with most websites, but some sites with complex layouts or anti-bot measures may require adjustments.