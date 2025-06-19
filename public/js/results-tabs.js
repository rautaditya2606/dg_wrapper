document.addEventListener('DOMContentLoaded', () => {
    const tabs = document.querySelectorAll('.tab');
    const webResults = document.getElementById('web-results');
    const imageResults = document.getElementById('image-results');

    tabs.forEach(tab => {
        tab.addEventListener('click', () => {
            // Remove active class from all tabs
            tabs.forEach(t => t.classList.remove('active'));
            
            // Add active class to clicked tab
            tab.classList.add('active');

            // Show/hide results based on selected tab
            const tabType = tab.dataset.tab;
            if (tabType === 'web') {
                if (webResults) {
                    webResults.style.display = 'block';
                }
                if (imageResults) {
                    imageResults.style.display = 'none';
                }
            } else if (tabType === 'images') {
                if (webResults) {
                    webResults.style.display = 'none';
                }
                if (imageResults) {
                    imageResults.style.display = 'block';
                }
            }
        });
    });
});
