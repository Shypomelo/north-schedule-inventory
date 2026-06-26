"use client";

import React, { createContext, useContext, useState, useEffect } from 'react';
import { User } from '@/lib/db/types';
import { dbAdapter } from '@/lib/db';

interface UserContextType {
  currentUser: User | null;
  allUsers: User[];
  setCurrentUser: (user: User) => void;
  isLoading: boolean;
}

const UserContext = createContext<UserContextType | undefined>(undefined);

export function UserProvider({ children }: { children: React.ReactNode }) {
  const [currentUser, setCurrentUser] = useState<User | null>(null);
  const [allUsers, setAllUsers] = useState<User[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    dbAdapter.getUsers().then(users => {
      setAllUsers(users);
      if (users.length > 0) {
        // Default to the first user for mock purposes
        setCurrentUser(users[0]);
      }
      setIsLoading(false);
    });
  }, []);

  return (
    <UserContext.Provider value={{ currentUser, allUsers, setCurrentUser, isLoading }}>
      {children}
    </UserContext.Provider>
  );
}

export function useUser() {
  const context = useContext(UserContext);
  if (context === undefined) {
    throw new Error('useUser must be used within a UserProvider');
  }
  return context;
}
