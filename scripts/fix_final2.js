const fs = require('fs');
const path = require('path');

const pagePath = path.join(__dirname, '../src/app/projects/[[...filter]]/page.tsx');
let pageContent = fs.readFileSync(pagePath, 'utf8');
pageContent = pageContent.replace(/matched_project_id: null,\n/g, '');
fs.writeFileSync(pagePath, pageContent, 'utf8');

const modalPath = path.join(__dirname, '../src/components/ProjectDetailModal.tsx');
let modalContent = fs.readFileSync(modalPath, 'utf8');
modalContent = modalContent.replace(/ActiveProjectDetailModal/g, 'ProjectDetailModal');
fs.writeFileSync(modalPath, modalContent, 'utf8');

const mockPath = path.join(__dirname, '../src/lib/db/mock.ts');
let mockContent = fs.readFileSync(mockPath, 'utf8');
mockContent = mockContent.replace(/Partial<Omit<'id'\|'created_at'\|'updated_at'>>/g, "Partial<Omit<Project, 'id'|'created_at'|'updated_at'>>");
fs.writeFileSync(mockPath, mockContent, 'utf8');

console.log('Final fixes applied');
