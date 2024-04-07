import { FsBlockstore } from 'blockstore-fs';
import { FsDatastore } from 'datastore-fs';

export const blockstore = new FsBlockstore("./blockstore");
export const datastore = new FsDatastore('./datastore');
