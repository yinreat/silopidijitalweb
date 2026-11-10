/// <reference types="vite/client" />

interface Window {
  proposDesktop?: {
    version?: string;
    deviceId?: string;
    updates?: {
      status: () => Promise<any>;
      check: () => Promise<any>;
      download: () => Promise<any>;
      install: () => Promise<any>;
      onStatus: (callback: (status: any) => void) => () => void;
    };
    openExternal?: (url: string) => Promise<any>;
    db?: {
      status: () => Promise<any>;
      setBusinessId: (businessId: string) => Promise<any>;
      startEmpty: () => Promise<any>;
      query: (spec: any) => Promise<any>;
      rpc: (name: string, args?: Record<string, unknown>) => Promise<any>;
      importRows: (payload: any) => Promise<any>;
      exportBackup: (password: string) => Promise<any>;
      importBackup: (base64: string, password: string, mode: string) => Promise<any>;
      saveStaffPassword: (staffId: string, password: string) => Promise<any>;
      verifyStaffPassword: (staffId: string, password: string) => Promise<any>;
      staffAction: (action: string, body?: Record<string, unknown>) => Promise<any>;
    };
  };
  proposDesktopVersion?: string;
}
