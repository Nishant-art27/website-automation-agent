**Assignment 04 \- Website Automation Agent**

Assignment Overview  
Create an intelligent website automation agent capable of interacting with web pages autonomously. This project serves as a mini-version of browser automation tools like Browser Use, demonstrating your understanding of AI-driven browser control and web automation.

Project Objective  
Build an automation agent that can navigate to a specific URL, interact with web elements, and perform form-filling operations without manual intervention. Your agent should demonstrate intelligent decision-making in identifying and manipulating web page elements.

Target Task  
**Your automation agent must perform the following task:**

* Navigate to: https://ui.shadcn.com/docs/forms/react-hook-form  
* Identify the form elements on the page (Name and Description fields)  
* Automatically fill in the Name and Description

Technical Requirements  
Required Tools & Technologies  
**Browser Automation Library (Choose one):**

* Playwright (Recommended)  
* Puppeteer

**Programming Language:**

* Any language of your choice (JavaScript/TypeScript, Python, Java, etc.)

Core Functionalities to Implement  
**Your agent must include the following tools/capabilities:**

* **take\_screenshot** \- Capture the current state of the browser window  
* **open\_browser** \- Initialize and launch a browser instance  
* **navigate\_to\_url** \- Direct the browser to a specific URL  
* **click\_on\_screen(x, y)** \- Perform mouse clicks at specified coordinates  
* **send\_keys** \- Input text into form fields or text areas  
* **scroll** \- Scroll the page to reveal hidden elements  
* **double\_click** \- Perform double-click actions when necessary

Implementation Guidelines

* **Agent Architecture:** Design your agent with modular tools that can be composed together  
* **Element Detection:** Implement intelligent element identification using selectors, XPath, or visual recognition  
* **Error Handling:** Include proper error handling for network issues, element not found, and timeout scenarios  
* **Logging:** Implement comprehensive logging to track agent actions and decisions  
* **Configuration:** Use environment variables or configuration files for API keys and settings

Project Deliverables

* **Source Code:** Complete, well-documented codebase with clear comments  
* **README File:** Include setup instructions, dependencies, and how to run the agent  
* **Architecture Document:** Brief explanation of your design decisions and agent workflow

Evaluation Criteria  
**Your project will be evaluated during your viva based on:**

* **Functionality (40%):** Does the agent successfully complete the target task?  
* **Code Quality (25%):** Is the code clean, modular, and well-documented?  
* **Agent Intelligence (20%):** How well does the agent handle element detection and decision-making?  
* **Error Handling (10%):** Robustness in handling edge cases and failures  
* **Documentation (5%):** Quality of README and inline code comments

Submission Guidelines

* **Deadline:** No fixed deadline — evaluation will occur during your viva voce examination  
* **Presentation:** Be prepared to demonstrate your agent live during the viva

Helpful Resources

* **Playwright Documentation:** https://playwright.dev/  
* **Puppeteer Documentation:** https://pptr.dev/  
* **Browser Use (Reference):** https://github.com/browser-use/browser-use  
* **OpenAI Agents SDK: https://openai.github.io/openai-agents-js**

