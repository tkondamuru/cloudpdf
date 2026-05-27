document.addEventListener('DOMContentLoaded', () => {
    const dropzone = document.getElementById('dropzone');
    const fileInput = document.getElementById('fileInput');
    const dashboard = document.getElementById('dashboard');
    const overallStatus = document.getElementById('overall-status');
    const progressBar = document.getElementById('progress-bar');
    const progressText = document.getElementById('progress-text');
    const progressPercent = document.getElementById('progress-percent');
    const fileList = document.getElementById('file-list');

    let totalFiles = 0;
    let completedFiles = 0;
    let fileCards = [];

    // Trigger click on file input when dropzone is clicked
    dropzone.addEventListener('click', () => fileInput.click());

    // File selection event
    fileInput.addEventListener('change', (e) => {
        if (e.target.files.length > 0) {
            handleFiles(e.target.files);
        }
    });

    // Drag and Drop listeners
    ['dragenter', 'dragover'].forEach(eventName => {
        dropzone.addEventListener(eventName, (e) => {
            e.preventDefault();
            e.stopPropagation();
            dropzone.classList.add('dragover');
        }, false);
    });

    ['dragleave', 'drop'].forEach(eventName => {
        dropzone.addEventListener(eventName, (e) => {
            e.preventDefault();
            e.stopPropagation();
            dropzone.classList.remove('dragover');
        }, false);
    });

    dropzone.addEventListener('drop', (e) => {
        const dt = e.dataTransfer;
        const files = dt.files;
        if (files.length > 0) {
            handleFiles(files);
        }
    });

    // Core upload & process function
    async function handleFiles(files) {
        // Reset state
        totalFiles = files.length;
        completedFiles = 0;
        fileCards = [];
        fileList.innerHTML = '';
        progressBar.style.width = '0%';
        progressText.textContent = `0 / ${totalFiles} Completed`;
        progressPercent.textContent = '0%';
        
        // Show dashboard, scroll to it
        dashboard.classList.remove('hidden');
        dashboard.scrollIntoView({ behavior: 'smooth' });

        overallStatus.className = 'overall-status processing';
        overallStatus.textContent = 'Uploading...';

        // Prepare File Cards in UI
        for (let i = 0; i < files.length; i++) {
            createFileCard(files[i], i);
        }

        // Build form data
        const formData = new FormData();
        for (let i = 0; i < files.length; i++) {
            formData.append('files', files[i]);
        }

        try {
            // Post files and stream response chunk-by-chunk (SSE over POST)
            const response = await fetch('/api/process', {
                method: 'POST',
                body: formData
            });

            if (!response.ok) {
                throw new Error(`Server returned HTTP ${response.status}`);
            }

            const reader = response.body.getReader();
            const decoder = new TextDecoder('utf-8');
            let buffer = '';
            let currentEvent = '';

            while (true) {
                const { value, done } = await reader.read();
                if (done) break;

                buffer += decoder.decode(value, { stream: true });
                const lines = buffer.split('\n');
                
                // Keep partial line in buffer
                buffer = lines.pop();

                for (const line of lines) {
                    const trimmed = line.trim();
                    if (!trimmed) continue;

                    if (trimmed.startsWith('event: ')) {
                        currentEvent = trimmed.substring(7).trim();
                    } else if (trimmed.startsWith('data: ')) {
                        const dataStr = trimmed.substring(6).trim();
                        try {
                            const data = JSON.parse(dataStr);
                            handleSseEvent(currentEvent, data);
                        } catch (err) {
                            console.error('Failed to parse SSE JSON:', dataStr, err);
                        }
                    }
                }
            }

        } catch (err) {
            console.error('Error during upload / processing:', err);
            overallStatus.className = 'overall-status';
            overallStatus.style.background = 'rgba(239, 68, 68, 0.15)';
            overallStatus.style.color = '#f87171';
            overallStatus.textContent = 'Error';
            
            // Mark remaining idle files as failed
            fileCards.forEach(card => {
                const badge = card.querySelector('.file-status-badge');
                if (badge.textContent === 'IDLE' || badge.textContent === 'UPLOADING' || badge.textContent === 'PROCESSING') {
                    badge.className = 'file-status-badge badge-failed';
                    badge.textContent = 'FAILED';
                    const details = document.createElement('div');
                    details.className = 'file-details';
                    details.textContent = `Batch upload error: ${err.message}`;
                    card.appendChild(details);
                }
            });
        }
    }

    // Helper to render initial file status cards
    function createFileCard(file, index) {
        const card = document.createElement('div');
        card.className = 'file-card';
        card.id = `file-card-${index}`;

        const sizeKB = (file.size / 1024).toFixed(1);

        card.innerHTML = `
            <div class="file-card-main">
                <div class="file-info">
                    <span class="file-icon">📄</span>
                    <div>
                        <div class="file-name" title="${escapeHtml(file.name)}">${escapeHtml(file.name)}</div>
                        <div class="file-size">${sizeKB} KB</div>
                    </div>
                </div>
                <div class="file-status-badge">Idle</div>
            </div>
        `;

        fileList.appendChild(card);
        fileCards.push(card);
    }

    // Handle SSE events emitted from backend
    function handleSseEvent(event, data) {
        if (event === 'start') {
            overallStatus.className = 'overall-status processing';
            overallStatus.textContent = 'Processing...';
        } 
        else if (event === 'progress') {
            const card = document.getElementById(`file-card-${data.index}`);
            if (!card) return;

            const badge = card.querySelector('.file-status-badge');
            
            // Clear existing details if any
            const existingDetails = card.querySelector('.file-details');
            if (existingDetails) existingDetails.remove();

            // Set badge class and text based on status
            if (data.status === 'Uploading') {
                badge.className = 'file-status-badge badge-uploading';
                badge.textContent = 'UPLOADING';
            } 
            else if (data.status === 'Processing') {
                badge.className = 'file-status-badge badge-processing';
                badge.textContent = 'PROCESSING';
            } 
            else if (data.status === 'Completed') {
                badge.className = 'file-status-badge badge-completed';
                badge.textContent = 'COMPLETED';
                
                // Automatically download the generated PDF file
                downloadBase64File(data.pdfBytesBase64, data.pdfName, 'application/pdf');

                // Add success log details with a manual download button
                const details = document.createElement('div');
                details.className = 'file-details';
                details.innerHTML = `
                    <div style="display: flex; justify-content: space-between; align-items: center; width: 100%;">
                        <span>Generated PDF: <strong>${escapeHtml(data.pdfName)}</strong></span>
                        <button class="download-btn" data-base64="${data.pdfBytesBase64}" data-name="${data.pdfName}">Download PDF</button>
                    </div>
                `;
                card.appendChild(details);

                // Wire up manual download button
                details.querySelector('.download-btn').addEventListener('click', (e) => {
                    downloadBase64File(e.target.dataset.base64, e.target.dataset.name, 'application/pdf');
                });

                completedFiles++;
                updateProgress();
            } 
            else if (data.status === 'Failed') {
                badge.className = 'file-status-badge badge-failed';
                badge.textContent = 'FAILED';

                // Add error details
                const details = document.createElement('div');
                details.className = 'file-details';
                details.textContent = `Error: ${data.error}`;
                card.appendChild(details);

                completedFiles++;
                updateProgress();
            }
        } 
        else if (event === 'complete') {
            overallStatus.className = 'overall-status completed';
            overallStatus.textContent = 'Finished';
        }
        else if (event === 'error') {
            overallStatus.className = 'overall-status';
            overallStatus.style.background = 'rgba(239, 68, 68, 0.15)';
            overallStatus.style.color = '#f87171';
            overallStatus.textContent = 'Error';
            alert(`Stream error occurred: ${data.message}`);
        }
    }

    // Update progress numbers
    function updateProgress() {
        const percent = Math.round((completedFiles / totalFiles) * 100);
        progressBar.style.width = `${percent}%`;
        progressText.textContent = `${completedFiles} / ${totalFiles} Completed`;
        progressPercent.textContent = `${percent}%`;
    }

    // Helper to decode Base64 string and trigger a browser download
    function downloadBase64File(base64Data, fileName, contentType) {
        const byteCharacters = atob(base64Data);
        const byteNumbers = new Array(byteCharacters.length);
        for (let i = 0; i < byteCharacters.length; i++) {
            byteNumbers[i] = byteCharacters.charCodeAt(i);
        }
        const byteArray = new Uint8Array(byteNumbers);
        const blob = new Blob([byteArray], { type: contentType });
        
        const link = document.createElement('a');
        link.href = URL.createObjectURL(blob);
        link.download = fileName;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        URL.revokeObjectURL(link.href);
    }

    // Helper to escape HTML characters
    function escapeHtml(text) {
        const div = document.createElement('div');
        div.innerText = text;
        return div.innerHTML;
    }
});
