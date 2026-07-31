export interface Photo {
  id: string;
  full: string;
  thumb: string;
  width?: number;
  height?: number;
  caption?: string;
  date?: number;
  video?: boolean;
  tags?: string[];
}

export interface PhotosData {
  user: string;
  syncedAt: string;
  total: number;
  photos: Photo[];
}
