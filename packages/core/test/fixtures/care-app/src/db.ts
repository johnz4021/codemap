type Row = Record<string, any>;
export const db = {
  async update(table: string, row: Row): Promise<void> {},
  async where(table: string, filter: Row): Promise<Row[]> { return []; },
};
