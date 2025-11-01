import { useEffect, useState } from 'react';
import { Card } from './ui/card';
import { Button } from './ui/button';
import { Badge } from './ui/badge';
import { Brain, CheckCircle2, XCircle } from 'lucide-react';
import { toast } from 'sonner@2.0.3';
import { readAll } from '../../../../lib/storage.js';

// Message helpers
function sendSWMessage(message) {
  return new Promise((resolve, reject) => {
    try {
      chrome.runtime.sendMessage(message, (resp) => {
        if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
        resolve(resp);
      });
    } catch (e) { reject(e); }
  });
}

interface QuizViewProps { selectedSubject?: string }

export function QuizView({ selectedSubject }: QuizViewProps) {
  const [currentQuestion, setCurrentQuestion] = useState(0);
  const [selectedAnswer, setSelectedAnswer] = useState<number | null>(null);
  const [showResult, setShowResult] = useState(false);
  const [questions, setQuestions] = useState<any[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [cards, setCards] = useState<any[]>([]);

  const currentQ = (questions && questions[currentQuestion]) || null;

  useEffect(() => {
    // load cards (first-run)
    (async () => {
      try {
        const all = await readAll();
        setCards(all || []);
      } catch (e) { console.debug('QuizView: failed to read cards', e); }
    })();
  }, []);

  const handleAnswer = (index: number) => {
    setSelectedAnswer(index);
    setShowResult(true);
    
    if (index === currentQ.correct) {
      toast.success('Correct! 🎉');
    } else {
      toast.error('Not quite right');
    }
  };

  const nextQuestion = () => {
    if (currentQuestion < questions.length - 1) {
      setCurrentQuestion(currentQuestion + 1);
      setSelectedAnswer(null);
      setShowResult(false);
    } else {
      toast.success('Quiz completed!');
      setCurrentQuestion(0);
      setSelectedAnswer(null);
      setShowResult(false);
    }
  };

  return (
    <div className="p-4 space-y-6">
      <div>
        <div className="flex items-center gap-2 mb-2">
          <Brain className="w-5 h-5 text-purple-600" />
          <h2 className="text-gray-900">Quiz Mode</h2>
        </div>
        <p className="text-sm text-gray-500">Test your knowledge from saved clips</p>
      </div>

      {/* Progress */}
      <div className="flex items-center justify-between text-sm">
        <span className="text-gray-600">
          Question {currentQuestion + 1} of {questions ? questions.length : 0}
        </span>
        <Badge variant="secondary">{currentQ ? currentQ.subject || 'General' : 'General'}</Badge>
      </div>

      {/* Question Card */}
      <Card className="p-4 space-y-4">
        <div className="text-gray-900">
          {currentQ ? currentQ.q : 'No questions yet. Click Generate to create MCQs from saved clips.'}
        </div>

        <div className="space-y-2">
          {(currentQ && currentQ.choices ? currentQ.choices : []).map((answer, index) => {
            const isSelected = selectedAnswer === index;
            const isCorrect = currentQ && currentQ.a === answer;
            
            let buttonClass = 'justify-start text-left h-auto py-3';
            if (showResult && isSelected) {
              buttonClass += isCorrect 
                ? ' bg-green-50 border-green-500 text-green-900' 
                : ' bg-red-50 border-red-500 text-red-900';
            }

            return (
              <Button
                key={index}
                variant="outline"
                className={`w-full ${buttonClass}`}
                onClick={() => !showResult && handleAnswer(index)}
                disabled={showResult}
              >
                <span className="flex-1">{answer}</span>
                {showResult && isSelected && (
                  isCorrect ? (
                    <CheckCircle2 className="w-4 h-4 text-green-600" />
                  ) : (
                    <XCircle className="w-4 h-4 text-red-600" />
                  )
                )}
              </Button>
            );
          })}
        </div>

        {showResult && (
          <Button className="w-full" onClick={nextQuestion}>
            {currentQuestion < (questions ? questions.length - 1 : 0) ? 'Next Question' : 'Finish Quiz'}
          </Button>
        )}

        {/* Controls */}
        <div className="mt-4 flex gap-2">
          <Button onClick={async () => {
            if (!cards || cards.length === 0) { toast.error('No saved clips to generate questions from'); return; }
            // Pick the first card matching the selected subject (or first overall)
            const card = (selectedSubject && selectedSubject !== 'All subjects')
              ? cards.find(c => (c.subject || 'General').toLowerCase() === selectedSubject.toLowerCase()) || cards[0]
              : cards[0];
            setLoading(true);
            const requestId = String(Date.now()) + '-' + Math.random().toString(36).slice(2,6);
            try {
              // send message to SW to generate MCQs
              await sendSWMessage({ type: 'CLIPNEST_GENERATE_MCQ', requestId, card });
              // wait for response via runtime.onMessage (listener below)
              const resp = await new Promise((resolve, reject) => {
                const onMsg = (m) => {
                  try {
                    if (m && m.type === 'CLIPNEST_GENERATE_MCQ_RESPONSE' && m.requestId === requestId) {
                      chrome.runtime.onMessage.removeListener(onMsg);
                      resolve(m);
                    }
                  } catch (e) { /* ignore */ }
                };
                chrome.runtime.onMessage.addListener(onMsg);
                // timeout
                setTimeout(() => { chrome.runtime.onMessage.removeListener(onMsg); resolve({ error: 'timeout' }); }, 45000);
              });
              if (!resp || resp.error) { toast.error('Failed to generate questions: ' + (resp && resp.error ? resp.error : 'unknown')); setLoading(false); return; }
              const qs = resp.questions || [];
              // Normalize shape to { q, a, choices }
              const normalized = qs.map((x) => ({ q: x.q || x.question || '', a: x.a || x.answer || '', choices: x.choices || x.options || [] }));
              setQuestions(normalized);
              setCurrentQuestion(0);
              setSelectedAnswer(null);
              setShowResult(false);
            } catch (e) { console.debug('generate MCQ error', e); toast.error('Generation failed'); }
            setLoading(false);
          }} disabled={loading}>{loading ? 'Generating...' : 'Generate MCQs'}</Button>
        </div>
      </Card>

      {/* Stats */}
      <div className="grid grid-cols-3 gap-3">
        <Card className="p-3 text-center">
          <div className="text-purple-600">12</div>
          <div className="text-gray-500 text-xs mt-1">Completed</div>
        </Card>
        <Card className="p-3 text-center">
          <div className="text-green-600">85%</div>
          <div className="text-gray-500 text-xs mt-1">Accuracy</div>
        </Card>
        <Card className="p-3 text-center">
          <div className="text-blue-600">7</div>
          <div className="text-gray-500 text-xs mt-1">Day Streak</div>
        </Card>
      </div>
    </div>
  );
}
