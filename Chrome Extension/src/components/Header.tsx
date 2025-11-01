import { ChevronDown } from 'lucide-react';
import { Button } from './ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from './ui/dropdown-menu';
import { toast } from 'sonner@2.0.3';
import { readAll } from '../../../../lib/storage.js';
import { useEffect, useState } from 'react';

interface HeaderProps {
  selectedSubject: string;
  onSubjectChange: (subject: string) => void;
  onNewClip: () => void;
}

export function Header({ selectedSubject, onSubjectChange, onNewClip }: HeaderProps) {
  const [subjects, setSubjects] = useState<string[]>(['All subjects']);

  useEffect(() => {
    (async () => {
      try {
        const all = await readAll();
        const subs = Array.from(new Set((all || []).map((c) => (c.subject || 'General').trim()))).sort();
        setSubjects(['All subjects', ...subs]);
      } catch (e) { console.debug('Header: failed to read subjects', e); }
    })();
  }, []);

  return (
    <div className="flex items-center justify-between px-4 py-3 border-b border-gray-200">
      <div className="flex items-center gap-3">
        <h1 className="text-gray-900">ClipNest</h1>
        
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button className="flex items-center gap-1 px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-100 rounded-md transition-colors">
              {selectedSubject}
              <ChevronDown className="w-4 h-4" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            {subjects.map((subject) => (
              <DropdownMenuItem
                key={subject}
                onClick={() => onSubjectChange(subject)}
                className={selectedSubject === subject ? 'bg-gray-100' : ''}
              >
                {selectedSubject === subject && '✓ '}
                {subject}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      <Button
        size="sm"
        onClick={() => {
          onNewClip();
          toast.success('New clip created');
        }}
      >
        New clip
      </Button>
    </div>
  );
}
