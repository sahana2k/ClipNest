import { useEffect, useState } from 'react';
import { Header } from './components/Header';
import { ClipView } from './components/ClipView';
import { TodayView } from './components/TodayView';
import { QuizView } from './components/QuizView';
import { ManageView } from './components/ManageView';
import { SettingsPanel } from './components/SettingsPanel';
import { readSettings, updateSettings } from '../lib/storage.js';

export default function App() {
  const [currentView, setCurrentView] = useState<'clips' | 'today' | 'quiz' | 'manage'>('clips');
  const [selectedSubject, setSelectedSubject] = useState('All subjects');
  const [showSettings, setShowSettings] = useState(false);

  return (
    <div className="w-[400px] h-[600px] bg-white flex flex-col">
      <Header 
        selectedSubject={selectedSubject}
        onSubjectChange={(s) => {
          setSelectedSubject(s);
          try { updateSettings({ subjectFilter: s }); } catch (e) { console.debug('failed to persist subject', e); }
        }}
        onNewClip={() => console.log('New clip')}
      />
      
      <div className="flex-1 overflow-hidden flex">
        {showSettings ? (
          <SettingsPanel onClose={() => setShowSettings(false)} />
        ) : (
          <>
            {/* Navigation Sidebar */}
            <div className="w-32 border-r border-gray-200 p-2 space-y-2">
              <button
                onClick={() => setCurrentView('clips')}
                className={`w-full px-3 py-2 rounded-lg text-sm transition-colors ${
                  currentView === 'clips'
                    ? 'bg-blue-600 text-white'
                    : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
                }`}
              >
                Clips
              </button>
              <button
                onClick={() => setCurrentView('today')}
                className={`w-full px-3 py-2 rounded-lg text-sm transition-colors ${
                  currentView === 'today'
                    ? 'bg-blue-600 text-white'
                    : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
                }`}
              >
                Today
              </button>
              <button
                onClick={() => setCurrentView('quiz')}
                className={`w-full px-3 py-2 rounded-lg text-sm transition-colors ${
                  currentView === 'quiz'
                    ? 'bg-blue-600 text-white'
                    : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
                }`}
              >
                Quiz
              </button>
              <button
                onClick={() => setCurrentView('manage')}
                className={`w-full px-3 py-2 rounded-lg text-sm transition-colors ${
                  currentView === 'manage'
                    ? 'bg-blue-600 text-white'
                    : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
                }`}
              >
                Manage
              </button>
              <button
                onClick={() => setShowSettings(true)}
                className="w-full px-3 py-2 rounded-lg text-sm bg-gray-100 text-gray-700 hover:bg-gray-200 transition-colors mt-auto"
              >
                Settings
              </button>
            </div>

            {/* Main Content */}
            <div className="flex-1 overflow-auto">
              {currentView === 'clips' && <ClipView selectedSubject={selectedSubject} />}
              {currentView === 'today' && <TodayView />}
              {currentView === 'quiz' && <QuizView selectedSubject={selectedSubject} />}
              {currentView === 'manage' && <ManageView />}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
