import { useEffect, useState } from 'react';
import { Card } from './ui/card';
import { Button } from './ui/button';
import { Badge } from './ui/badge';
import { Input } from './ui/input';
import { Search, Edit2, Trash2 } from 'lucide-react';
import { toast } from 'sonner@2.0.3';
import { readAll, removeCard as storageRemoveCard, readSettings, updateSettings, updateCard } from '../../../../lib/storage.js';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from './ui/dropdown-menu';
import { Dialog, DialogContent, DialogTitle, DialogHeader, DialogFooter } from './ui/dialog';

interface SavedCard {
  id: number;
  title: string;
  subject: string;
  description: string;
  savedDate: string;
}

export function ManageView() {
  const [searchQuery, setSearchQuery] = useState('');
  const [cards, setCards] = useState<SavedCard[]>([]);
  const [subjectFilter, setSubjectFilter] = useState<string>('All');
  const [subjects, setSubjects] = useState<string[]>([]);

  useEffect(() => {
    (async () => {
      try {
        const all = await readAll();
        // Map persisted card shape to SavedCard interface where possible
        const mapped = (all || []).map((c) => ({
          id: c.id || c.createdAt || Math.random(),
          title: c.topic || (c.page && c.page.title) || 'Untitled',
          subject: c.subject || 'General',
          description: (typeof c.notes === 'string' ? c.notes : (c.notes?.short || '')) || (c.snippet?.text || ''),
          savedDate: c.createdAt ? new Date(c.createdAt).toISOString() : (c.savedDate || new Date().toISOString())
        }));
        setCards(mapped);
        // populate subjects list (case-insensitive unique)
        const subs = Array.from(new Set(mapped.map(m => (m.subject || 'General').trim()))).sort();
        setSubjects(subs);
        // load persisted subject filter from settings
        try {
          const s = await readSettings();
          if (s && s.subjectFilter) setSubjectFilter(s.subjectFilter);
        } catch (e) { /* ignore */ }
      } catch (e) { console.debug('ManageView: failed to read stored cards', e); }
    })();

    const onChange = (changes, area) => {
      if (area === 'local') {
        (async () => {
          try {
            const all = await readAll();
            const mapped = (all || []).map((c) => ({
              id: c.id || c.createdAt || Math.random(),
              title: c.topic || (c.page && c.page.title) || 'Untitled',
              subject: c.subject || 'General',
              description: (typeof c.notes === 'string' ? c.notes : (c.notes?.short || '')) || (c.snippet?.text || ''),
              savedDate: c.createdAt ? new Date(c.createdAt).toISOString() : (c.savedDate || new Date().toISOString())
            }));
            setCards(mapped);
            setSubjects(Array.from(new Set(mapped.map(m => (m.subject || 'General').trim()))).sort());
          } catch (e) { console.debug('ManageView refresh onChange error', e); }
        })();
      }
    };
    try { chrome.storage.onChanged.addListener(onChange); } catch (e) { /* ignore */ }
    return () => { try { chrome.storage.onChanged.removeListener(onChange); } catch(e) {} };
  }, []);

  const [editing, setEditing] = useState<SavedCard | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);

  const saveEdit = async () => {
    if (!editing) return;
    try {
      await updateCard({ id: editing.id, topic: editing.title, subject: editing.subject, notes: editing.description });
      setCards(prev => prev.map(c => c.id === editing.id ? editing : c));
      setDialogOpen(false);
      toast.success('Saved');
    } catch (e) { console.debug('saveEdit error', e); toast.error('Save failed'); }
  };

  const deleteCard = (id: number) => {
    (async () => {
      try {
        await storageRemoveCard(id);
        setCards((prev) => prev.filter(card => card.id !== id));
        toast.success('Card deleted');
      } catch (e) {
        console.debug('ManageView delete error', e);
        toast.error('Failed to delete card');
      }
    })();
  };

  const handleSubjectChange = async (next) => {
    setSubjectFilter(next);
    try { await updateSettings({ subjectFilter: next }); } catch (e) { console.debug('failed to persist subjectFilter', e); }
  };

  const editCard = (id: number) => {
    toast.info('Edit mode activated');
  };

  const filteredCards = cards.filter(card => {
    const matchesQuery = card.title.toLowerCase().includes(searchQuery.toLowerCase()) || card.description.toLowerCase().includes(searchQuery.toLowerCase());
    const matchesSubject = (subjectFilter === 'All') ? true : ((card.subject || 'General').toLowerCase() === (subjectFilter || '').toLowerCase());
    return matchesQuery && matchesSubject;
  });

  return (
    <div className="p-4 space-y-4">
      <div>
        <h2 className="text-gray-900 mb-1">Manage cards</h2>
        <p className="text-sm text-gray-500">View and organize your saved clips</p>
      </div>

      {/* Search */}
      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
        <Input
          placeholder="Search cards..."
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          className="pl-10"
        />
      </div>

      {/* Subject filter */}
      <div className="flex items-center gap-3">
        <label className="text-sm text-gray-600">Subject:</label>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button className="flex items-center gap-2 px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-100 rounded-md transition-colors">
              {subjectFilter}
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent>
            <DropdownMenuItem onClick={() => handleSubjectChange('All')}>{subjectFilter === 'All' ? '✓ ' : ''}All</DropdownMenuItem>
            {subjects.map((s) => (
              <DropdownMenuItem key={s} onClick={() => handleSubjectChange(s)}>{subjectFilter === s ? '✓ ' : ''}{s}</DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {/* Stats */}
      <div className="flex gap-3 text-sm">
        <div className="flex-1 text-center p-2 bg-gray-50 rounded-lg">
          <div className="text-gray-900">{cards.length}</div>
          <div className="text-gray-500 text-xs">Total Cards</div>
        </div>
        <div className="flex-1 text-center p-2 bg-gray-50 rounded-lg">
          <div className="text-gray-900">{new Set(cards.map(c => c.subject)).size}</div>
          <div className="text-gray-500 text-xs">Subjects</div>
        </div>
      </div>

      {/* Cards List */}
      <div className="space-y-3">
        {filteredCards.map((card) => (
          <Card key={card.id} className="p-4 space-y-3">
            <div className="flex items-start justify-between gap-2">
              <div className="flex-1">
                <div className="text-sm text-gray-900 mb-1">{card.title}</div>
                <Badge variant="secondary" className="text-xs">
                  {card.subject}
                </Badge>
              </div>
              <div className="flex gap-1">
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-8 w-8 p-0"
                  onClick={() => editCard(card.id)}
                >
                  <Edit2 className="w-3 h-3 text-gray-600" />
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-8 w-8 p-0"
                  onClick={() => deleteCard(card.id)}
                >
                  <Trash2 className="w-3 h-3 text-gray-600" />
                </Button>
              </div>
            </div>
            
            <p className="text-xs text-gray-600 line-clamp-2">
              {card.description}
            </p>

            <div className="text-xs text-gray-400">
              Saved on {new Date(card.savedDate).toLocaleDateString()}
            </div>
          </Card>
        ))}
      </div>

      {filteredCards.length === 0 && (
        <div className="text-center py-12 text-gray-500">
          No cards found
        </div>
      )}

      {/* Edit Dialog */}
      <Dialog open={dialogOpen} onOpenChange={(v) => setDialogOpen(v)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Edit card</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <Input value={editing?.title || ''} onChange={(e) => setEditing(editing ? { ...editing, title: e.target.value } : null)} />
            <Input value={editing?.subject || ''} onChange={(e) => setEditing(editing ? { ...editing, subject: e.target.value } : null)} />
            <Input value={editing?.description || ''} onChange={(e) => setEditing(editing ? { ...editing, description: e.target.value } : null)} />
          </div>
          <DialogFooter>
            <div className="flex gap-2">
              <Button variant="outline" onClick={() => setDialogOpen(false)}>Cancel</Button>
              <Button onClick={saveEdit}>Save</Button>
            </div>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
