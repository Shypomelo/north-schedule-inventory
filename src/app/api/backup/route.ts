import { NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';

export async function POST(request: Request) {
  try {
    const data = await request.json();
    const date = new Date();
    // YYYYMMDD-HHmm
    const timestamp = date.getFullYear() +
      String(date.getMonth() + 1).padStart(2, '0') +
      String(date.getDate()).padStart(2, '0') + '-' +
      String(date.getHours()).padStart(2, '0') +
      String(date.getMinutes()).padStart(2, '0');
    
    const backupDir = path.join(process.cwd(), 'backup');
    if (!fs.existsSync(backupDir)) {
      fs.mkdirSync(backupDir, { recursive: true });
    }
    
    const filePath = path.join(backupDir, `active-projects-backup-${timestamp}.json`);
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
    
    return NextResponse.json({ success: true, filePath });
  } catch (error) {
    console.error('Backup error:', error);
    return NextResponse.json({ success: false, error: 'Failed to backup' }, { status: 500 });
  }
}
