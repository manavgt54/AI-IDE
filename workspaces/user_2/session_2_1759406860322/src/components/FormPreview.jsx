import React, { useState } from "react";
import axios from "axios";
import { API_URL } from '../api';

const FormPreview = ({ form }) => {
  const [answers, setAnswers] = useState(() =>
    form.questions.map(() => null)
  );
  const [submitting, setSubmitting] = useState(false);

  if (!form) return <p>Loading...</p>;

  const handleChange = (qIdx, value, option = null, mcqType = null) => {
    setAnswers((prev) => {
      const updated = [...prev];
      if (mcqType === "multiple") {
        // Checkbox multiple answers
        let arr = Array.isArray(updated[qIdx]) ? [...updated[qIdx]] : [];
        if (value) {
          if (!arr.includes(option)) arr.push(option);
        } else {
          arr = arr.filter((o) => o !== option);
        }
        updated[qIdx] = arr;
      } else {
        // Text or single select radio
        updated[qIdx] = value;
      }
      return updated;
    });
  };

  const handleSubmit = async () => {
    setSubmitting(true);
    try {
      // Send answers as { answers: [...] } to backend
      const res = await axios.post(`${API_URL}/api/forms/create`, data);
        { answers }
      
      alert("Responses submitted successfully!");
    } catch (err) {
      alert("Error submitting responses");
      console.error(err);
    }
    setSubmitting(false);
  };

  return (
    <div className="min-h-screen bg-gray-50 flex justify-center py-6 px-3">
      <div className="bg-white max-w-3xl w-full rounded-lg shadow-md p-6">
        {form.headerImage && (
          <img
            src={form.headerImage}
            alt="Header"
            className="w-full h-48 object-cover rounded-md mb-4"
          />
        )}
        <h1 className="text-3xl font-bold text-center mb-6">{form.title}</h1>

        {form.questions.map((q, idx) => (
          <div key={idx} className="mb-8 border-b pb-6">
            <h2 className="text-xl font-semibold mb-3">Question {idx + 1}</h2>
            {q.image && (
              <img
                src={q.image}
                alt="Question"
                className="w-48 h-48 object-cover rounded-md mb-4"
              />
            )}
            <p className="text-lg mb-3">{q.label}</p>

            {(q.type === "text" || q.type === "cloze" || q.type === "comprehension") && (
              <>
                {q.type === "comprehension" && <p className="mb-3">{q.passage}</p>}
                <input
                  type="text"
                  placeholder="Your answer"
                  className="border p-2 w-full"
                  value={answers[idx] || ""}
                  onChange={(e) => handleChange(idx, e.target.value)}
                />
              </>
            )}

            {q.type === "mcq" && (
              <div className="flex flex-col gap-2">
                {q.options.map((opt, oi) => (
                  <label key={oi} className="flex items-center gap-2">
                    {q.mcqType === "single" ? (
                      <input
                        type="radio"
                        name={`q-${idx}`}
                        checked={answers[idx] === opt}
                        onChange={() => handleChange(idx, opt)}
                      />
                    ) : (
                      <input
                        type="checkbox"
                        checked={Array.isArray(answers[idx]) && answers[idx].includes(opt)}
                        onChange={(e) =>
                          handleChange(idx, e.target.checked, opt, "multiple")
                        }
                      />
                    )}
                    {opt}
                  </label>
                ))}
              </div>
            )}
          </div>
        ))}

        <button
          onClick={handleSubmit}
          disabled={submitting}
          className="bg-green-600 text-white py-2 px-4 rounded w-full"
        >
          {submitting ? "Submitting..." : "Submit Responses"}
        </button>
      </div>
    </div>
  );
};

export default FormPreview;
