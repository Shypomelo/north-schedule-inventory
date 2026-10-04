export type WeekImageDay = { date: string; tasks: { title: string; detail: string }[] };

export async function renderScheduleWeekPng(days: WeekImageDay[], generatedAt: Date): Promise<Blob> {
  const canvas = document.createElement('canvas');
  const columnWidth = 310, gap = 12, margin = 36, cardHeight = 76;
  canvas.width = margin * 2 + days.length * columnWidth + (days.length - 1) * gap;
  canvas.height = Math.max(470, 160 + Math.max(...days.map(day => day.tasks.length), 1) * (cardHeight + 10) + 42);
  const context = canvas.getContext('2d');
  if (!context) throw new Error('無法產生排程圖片。');
  context.fillStyle = '#f5f7fb'; context.fillRect(0, 0, canvas.width, canvas.height);
  context.fillStyle = '#15213a'; context.font = 'bold 30px sans-serif';
  context.fillText('週排程', margin, 53);
  context.font = '18px sans-serif'; context.fillStyle = '#475569';
  context.fillText(`${days[0]?.date || ''} – ${days[days.length - 1]?.date || ''}`, margin, 84);
  context.font = '14px sans-serif';
  context.fillText(`產出時間 ${new Intl.DateTimeFormat('zh-TW', { timeZone: 'Asia/Taipei', dateStyle: 'medium', timeStyle: 'short' }).format(generatedAt)}`, margin, 109);
  days.forEach((day, index) => {
    const x = margin + index * (columnWidth + gap);
    context.fillStyle = '#e2e8f0'; context.fillRect(x, 130, columnWidth, 46);
    context.fillStyle = '#15213a'; context.font = 'bold 18px sans-serif'; context.fillText(day.date, x + 12, 159);
    if (!day.tasks.length) { context.font = '15px sans-serif'; context.fillStyle = '#64748b'; context.fillText('無排程', x + 12, 210); }
    day.tasks.forEach((task, taskIndex) => {
      const y = 187 + taskIndex * (cardHeight + 10);
      context.fillStyle = '#ffffff'; context.fillRect(x, y, columnWidth, cardHeight);
      context.strokeStyle = '#cbd5e1'; context.strokeRect(x + 0.5, y + 0.5, columnWidth - 1, cardHeight - 1);
      context.save(); context.beginPath(); context.rect(x + 12, y + 7, columnWidth - 24, cardHeight - 14); context.clip();
      context.fillStyle = '#172554'; context.font = 'bold 16px sans-serif'; context.fillText(task.title, x + 12, y + 27);
      context.fillStyle = '#475569'; context.font = '14px sans-serif'; context.fillText(task.detail, x + 12, y + 53);
      context.restore();
    });
  });
  return new Promise((resolve, reject) => canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('PNG 產生失敗。')), 'image/png'));
}
