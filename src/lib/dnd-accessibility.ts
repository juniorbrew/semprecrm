import type { Announcements, ScreenReaderInstructions } from '@dnd-kit/core';

import type { Language } from './i18n';

/**
 * Screen-reader copy for every drag-and-drop board (pipeline, tasks,
 * stage/status reorder). dnd-kit ships English defaults ("To pick up a
 * draggable item, press the space bar…") that are rendered into the DOM
 * and read aloud on every board — the one place the DOM translator
 * cannot reach, because the text is composed at announce time.
 *
 *   <DndContext accessibility={dndAccessibility(language)} …>
 */
export function dndAccessibility(language: Language): {
  announcements: Announcements;
  screenReaderInstructions: ScreenReaderInstructions;
} {
  if (language === 'en-US') {
    return {
      screenReaderInstructions: {
        draggable:
          'To pick up a draggable item, press the space bar. While dragging, use the arrow keys to move the item. Press space again to drop the item in its new position, or press escape to cancel.',
      },
      announcements: {
        onDragStart: ({ active }) => `Picked up draggable item ${active.id}.`,
        onDragOver: ({ active, over }) =>
          over
            ? `Draggable item ${active.id} was moved over droppable area ${over.id}.`
            : `Draggable item ${active.id} is no longer over a droppable area.`,
        onDragEnd: ({ active, over }) =>
          over
            ? `Draggable item ${active.id} was dropped over droppable area ${over.id}.`
            : `Draggable item ${active.id} was dropped.`,
        onDragCancel: ({ active }) => `Dragging was cancelled. Draggable item ${active.id} was dropped.`,
      },
    };
  }
  return {
    screenReaderInstructions: {
      draggable:
        'Para pegar um item, pressione a barra de espaço. Enquanto arrasta, use as setas do teclado para mover. Pressione espaço de novo para soltar na nova posição, ou Esc para cancelar.',
    },
    announcements: {
      onDragStart: ({ active }) => `Item ${active.id} selecionado para arrastar.`,
      onDragOver: ({ active, over }) =>
        over ? `Item ${active.id} está sobre a área ${over.id}.` : `Item ${active.id} não está mais sobre uma área.`,
      onDragEnd: ({ active, over }) =>
        over ? `Item ${active.id} solto na área ${over.id}.` : `Item ${active.id} solto.`,
      onDragCancel: ({ active }) => `Arrasto cancelado. Item ${active.id} voltou ao lugar.`,
    },
  };
}
