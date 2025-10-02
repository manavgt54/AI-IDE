Interactive Quiz App
An interactive quiz application built with React, Tailwind CSS, and JavaScript.
This app allows users to take quizzes with multiple question types, including Fill in the Blank, Multiple Choice (single/multiple answers), and True/False.
It’s lightweight, responsive, and optimized for a smooth user experience.

✨ Features
📝 Fill in the Blank questions with instant input validation.
✅ Multiple Choice questions with single & multiple answer support.
🔄 Automatic state handling (no weird “all options selected” bug 😉).
📱 Fully responsive design using Tailwind CSS.
🎯 Easy to customize question sets via JSON.
🛠 Tech Stack
Frontend: React (Vite)
Styling: Tailwind CSS
State Management: useState / useEffect
Deployment: Vercel
📦 Installation & Setup
Clone the repository

git clone https://github.com/your-username/quiz-app.git
cd quiz-app
Install dependencies

npm install
Run locally

npm run dev
Open your browser at:

http://localhost:5173
🚀 Deployment on Vercel
Push your project to GitHub.
Go to Vercel, sign in, and click "New Project".
Import your GitHub repo.
Select Framework: Vite (React).
Click Deploy — Vercel will give you a live link to share.
📂 Project Structure
quiz-app/
├── public/            # Static assets
├── src/
│   ├── components/    # React components
│   ├── data/          # Question sets (JSON)
│   ├── App.jsx
│   └── main.jsx
├── package.json
└── tailwind.config.js
🖼 Screenshots
(Optional: Add screenshots of your UI here)

🧠 How It Works
Each question is rendered dynamically from a JSON array.
Question type determines the input UI.
State updates only for the specific question interacted with.
Answers are validated on submission or in real-time (depending on config).
📜 License
This project is licensed under the MIT License — you’re free to use, modify, and distribute it.



