/**
 * Общие ресурсы движка: unit-геометрия, процедурные текстуры, кэш подписей
 * и кэш вывесок. Они живут в модулях и переживают отдельное здание.
 *
 * Отсюда единственная точка правды об их времени жизни. Здание, которому они
 * нужны, берёт ссылку при сборке и отдаёт при разборе; освобождаются они, когда
 * отдана последняя ссылка. Без этого разбор первого корпуса на экране выбора
 * кампуса освобождал бы геометрию, которой прямо сейчас пользуется второй, —
 * а горизонт проекта заявлен на пять корпусов и больше.
 */
import { disposeSharedGeometry } from '@building/geometry';
import { disposeLabelCache } from '@building/labels';
import { disposeSharedTextures } from '@building/materials';
import { disposeSignCache } from '@building/signs';

let holders = 0;

/** Взять ссылку на общие ресурсы. Возвращает функцию, отдающую её обратно. */
export function acquireSharedResources(): () => void {
  holders += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    holders -= 1;
    if (holders > 0) return;
    holders = 0;
    disposeLabelCache();
    disposeSignCache();
    disposeSharedTextures();
    disposeSharedGeometry();
  };
}

/** Сколько зданий сейчас держат общие ресурсы (для отладки и тестов). */
export function sharedResourceHolders(): number {
  return holders;
}
