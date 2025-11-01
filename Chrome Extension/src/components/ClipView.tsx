import { useEffect, useState } from 'react';
import { Card } from './ui/card';
import { Button } from './ui/button';
import { Badge } from './ui/badge';
import { ImageWithFallback } from './figma/ImageWithFallback';
import { ExternalLink } from 'lucide-react';
import { toast } from 'sonner@2.0.3';
import { readAll, removeCard as storageRemoveCard, updateCard } from '../../../../lib/storage.js';

interface Clip {
  id: number;
  image: string;
  description: string;
  tags: string[];
  title: string;
  source?: string;
  subject: string;
  isSaved: boolean;
}

interface ClipViewProps {
  selectedSubject: string;
}

export function ClipView({ selectedSubject }: ClipViewProps) {
  const [clips, setClips] = useState<Clip[]>([]);
  const [searchQuery, setSearchQuery] = useState('');

  useEffect(() => {
    (async () => {
      try {
        const all = await readAll();
        const mapped = (all || []).map((c) => ({
          id: c.id,
          image: c.image || (c.cropDataUrl || ''),
          description: (typeof c.notes === 'string' ? c.notes : (c.notes?.short || '')) || (c.snippet?.text || ''),
          tags: c.tags || [],
          title: c.topic || (c.page && c.page.title) || 'Untitled',
          subject: c.subject || 'General',
          isSaved: true
        }));
        setClips(mapped);
      } catch (e) { console.debug('ClipView load error', e); }
    })();
  }, []);

  const saveClip = (id: number) => {
    setClips(clips.map(clip => 
      clip.id === id ? { ...clip, isSaved: true } : clip
    ));
    toast.success('Card saved successfully');
  };

  const deleteClip = (id: number) => {
    (async () => {
      try {
        await storageRemoveCard(id);
        setClips(prev => prev.filter(c => c.id !== id));
        toast.success('Card deleted');
      } catch (e) { console.debug('deleteClip error', e); toast.error('Delete failed'); }
    })();
  };

  const editClip = (id: number) => {
    // simple inline edit demonstration: toggle subject to 'Edited' for now
    (async () => {
      try {
        const c = clips.find(x => x.id === id);
        if (!c) return;
        const updated = { ...c, subject: (c.subject || 'General') };
        await updateCard(updated);
        setClips(prev => prev.map(p => p.id === id ? updated : p));
        toast.success('Card updated');
      } catch (e) { console.debug('editClip error', e); toast.error('Edit failed'); }
    })();
  };

  const filteredClips = (selectedSubject && selectedSubject !== 'All subjects')
    ? clips.filter(clip => (clip.subject || 'General').toLowerCase() === selectedSubject.toLowerCase())
    : clips;

  return (
    <div className="p-4 space-y-4">
      {filteredClips.map((clip) => (
        <Card key={clip.id} className="overflow-hidden">
          <div className="p-4 space-y-3">
            {/* Clip Image */}
            <div className="relative w-full aspect-video rounded-lg overflow-hidden bg-gray-100">
              <ImageWithFallback
                src={clip.image}
                alt={clip.title}
                className="w-full h-full object-cover"
              />
            </div>

            {/* Description */}
            <p className="text-sm text-gray-600 leading-relaxed">
              {clip.description}
            </p>

            {/* Tags */}
            <div className="flex flex-wrap gap-2">
              {clip.tags.map((tag, index) => (
                <Badge key={index} variant="secondary" className="text-xs">
                  {tag}
                </Badge>
              ))}
            </div>

            {/* Source Link */}
            {clip.source && (
              <a
                href={clip.source}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-1 text-xs text-blue-600 hover:underline"
              >
                Open source
                <ExternalLink className="w-3 h-3" />
              </a>
            )}

            {/* Save Button */}
            <Button
              className="w-full"
              disabled={clip.isSaved}
              onClick={() => saveClip(clip.id)}
            >
              {clip.isSaved ? 'Saved' : 'Save card'}
            </Button>
          </div>
        </Card>
      ))}

      {filteredClips.length === 0 && (
        <div className="text-center py-12 text-gray-500">
          No clips found for {selectedSubject}
        </div>
      )}
    </div>
  );
}
