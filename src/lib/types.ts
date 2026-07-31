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

export interface Profile {
  name: string;
  image: string;
  description: string;
}

export interface PhotosData {
  user: string;
  profile?: Profile;
  syncedAt: string;
  total: number;
  photos: Photo[];
}
