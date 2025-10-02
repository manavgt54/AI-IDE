import {
  BrowserRouter as Router,
  Routes,
  Route
} from 'react-router-dom';

import Home from './pages/Home.jsx';
import FormBuilder from './components/FormBuilder';
import './output.css'; // Import Tailwind CSS styles

function App() {
  return (
    <Router>
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/builder" element={<FormBuilder />} />
      </Routes>
    </Router>
  );
}

export default App;
