// app.js

/**
 * Main JavaScript logic for handling events and UI interactions.
 * This script ensures the DOM is fully loaded before attempting to
 * access or manipulate elements.
 */
document.addEventListener('DOMContentLoaded', () => {
    console.log('DOM fully loaded and parsed.');

    // --- Feature: Event Handling & UI Interactions (Click Event) ---

    // 1. Select UI elements
    const myButton = document.getElementById('myButton');
    const displayParagraph = document.getElementById('displayParagraph');

    // Check if elements exist to prevent errors if the HTML structure changes
    if (myButton && displayParagraph) {
        // 2. Attach an event listener to the button
        myButton.addEventListener('click', () => {
            // 3. Perform UI interaction based on the event
            if (displayParagraph.textContent === 'Initial text.') {
                displayParagraph.textContent = 'Button was clicked! Text changed.';
                displayParagraph.style.color = 'blue';
                displayParagraph.style.fontWeight = 'bold';
            } else {
                displayParagraph.textContent = 'Initial text.';
                displayParagraph.style.color = 'black';
                displayParagraph.style.fontWeight = 'normal';
            }
            console.log('Button click event detected.');
        });
    } else {
        console.warn('Could not find #myButton or #displayParagraph. Check your HTML.');
    }

    // --- Feature: Event Handling & UI Interactions (Hover Event) ---

    const hoverBox = document.getElementById('hoverBox');

    if (hoverBox) {
        // Event listener for mouse entering the element
        hoverBox.addEventListener('mouseenter', () => {
            hoverBox.style.backgroundColor = '#e0ffe0'; // Light green
            hoverBox.textContent = 'You are hovering!';
            hoverBox.style.borderColor = 'green';
            console.log('Mouse entered hoverBox.');
        });

        // Event listener for mouse leaving the element
        hoverBox.addEventListener('mouseleave', () => {
            hoverBox.style.backgroundColor = '#f0f0f0'; // Light gray
            hoverBox.textContent = 'Hover over me!';
            hoverBox.style.borderColor = '#ccc';
            console.log('Mouse left hoverBox.');
        });
    } else {
        console.warn('Could not find #hoverBox. Check your HTML.');
    }

    // --- Feature: UI Interactions (Dynamic Element Creation) ---

    const addElementButton = document.getElementById('addElementButton');
    const dynamicContentArea = document.getElementById('dynamicContentArea');
    let clickCount = 0;

    if (addElementButton && dynamicContentArea) {
        addElementButton.addEventListener('click', () => {
            clickCount++;
            const newDiv = document.createElement('div');
            newDiv.className = 'dynamic-item';
            newDiv.textContent = `Dynamic Item ${clickCount}`;
            newDiv.style.padding = '5px';
            newDiv.style.margin = '5px 0';
            newDiv.style.backgroundColor = '#add8e6'; // Light blue
            newDiv.style.border = '1px solid #6a5acd'; // Slate blue
            newDiv.style.borderRadius = '3px';

            // Add an event listener to the newly created element
            newDiv.addEventListener('click', (event) => {
                alert(`You clicked: ${event.target.textContent}`);
                event.target.style.backgroundColor = '#ffb6c1'; // Light pink
            });

            dynamicContentArea.appendChild(newDiv);
            console.log(`Added new dynamic item: Dynamic Item ${clickCount}`);
        });
    } else {
        console.warn('Could not find #addElementButton or #dynamicContentArea. Check your HTML.');
    }

    // --- Global Utility Function (Example) ---
    // This function could be called from other parts of your application or even directly from HTML.
    window.updateStatusMessage = (message) => {
        const statusElement = document.getElementById('statusMessage');
        if (statusElement) {
            statusElement.textContent = `Status: ${message}`;
            console.log(`Status updated: ${message}`);
        } else {
            console.warn('Status message element not found.');
        }
    };

    // Initial status update
    window.updateStatusMessage('Application ready.');
});

// Example HTML structure that would work with this app.js:
/*
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>JS App</title>
    <style>
        body { font-family: Arial, sans-serif; margin: 20px; }
        #hoverBox {
            width: 200px;
            height: 50px;
            background-color: #f0f0f0;
            border: 1px solid #ccc;
            display: flex;
            align-items: center;
            justify-content: center;
            margin-top: 20px;
            cursor: pointer;
            transition: background-color 0.3s, border-color 0.3s;
        }
        #dynamicContentArea {
            border: 1px dashed #999;
            padding: 10px;
            margin-top: 20px;
            min-height: 50px;
        }
        .dynamic-item {
            cursor: pointer;
        }
    </style>
</head>
<body>
    <h1>Main JavaScript Logic</h1>

    <h2>Event Handling & UI Interactions (Click)</h2>
    <p id="displayParagraph">Initial text.</p>
    <button id="myButton">Toggle Text</button>

    <h2>Event Handling & UI Interactions (Hover)</h2>
    <div id="hoverBox">Hover over me!</div>

    <h2>UI Interactions (Dynamic Content)</h2>
    <button id="addElementButton">Add New Item</button>
    <div id="dynamicContentArea">
        <!-- Dynamic items will be added here -->
    </div>

    <p id="statusMessage" style="margin-top: 30px; font-style: italic;"></p>

    <script src="app.js"></script>
</body>
</html>
*/
