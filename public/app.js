const state = {
  queries: [],
  current: null,
  models: [],
  tableData: null,
  sortColumn: null,
  sortAsc: true,
  activeFilters: {},
};

const elements = {
  querySelect: document.querySelector("#querySelect"),
  queryDescription: document.querySelector("#queryDescription"),
  queryTitle: document.querySelector("#queryTitle"),
  credentialNotice: document.querySelector("#credentialNotice"),
  fields: document.querySelector("#fields"),
  form: document.querySelector("#queryForm"),
  runButton: document.querySelector("#runButton"),
  statusBadge: document.querySelector("#statusBadge"),
  message: document.querySelector("#message"),
  resultSection: document.querySelector("#resultSection"),
  resultTable: document.querySelector("#resultTable"),
  tableMeta: document.querySelector("#tableMeta"),
  tableFilters: document.querySelector("#tableFilters"),
};

function setMessage(text = "", type = "") {
  elements.message.textContent = text;
  elements.message.className = "message";
  if (!text) {
    elements.message.classList.add("hidden");
    return;
  }
  if (type) elements.message.classList.add(type);
}

function groupQueries(queries) {
  return queries.reduce((acc, query) => {
    (acc[query.category] ||= []).push(query);
    return acc;
  }, {});
}

function renderQueryOptions() {
  elements.querySelect.innerHTML = "";
  const grouped = groupQueries(state.queries);

  for (const [category, queries] of Object.entries(grouped)) {
    const group = document.createElement("optgroup");
    group.label = category;
    for (const query of queries) {
      const option = document.createElement("option");
      option.value = query.id;
      option.textContent = query.label;
      group.appendChild(option);
    }
    elements.querySelect.appendChild(group);
  }
}

function renderFields(query) {
  elements.fields.innerHTML = "";

  if (!query.fields.length) {
    const empty = document.createElement("div");
    empty.className = "empty-fields";
    empty.textContent = "Esta consulta não exige filtros digitados pelo usuário.";
    elements.fields.appendChild(empty);
    return;
  }

  for (const field of query.fields) {
    const wrapper = document.createElement("div");
    wrapper.className = "field";

    const label = document.createElement("label");
    label.htmlFor = `field-${field.name}`;
    label.textContent = field.label;

    const input = document.createElement("input");
    input.id = `field-${field.name}`;
    input.name = field.name;
    input.type = field.type || "text";
    input.placeholder = field.placeholder || "";
    input.required = Boolean(field.required);
    input.autocomplete = "off";

    if (field.min !== undefined) input.min = field.min;
    if (field.max !== undefined) input.max = field.max;
    if (field.name === "makemodel") input.setAttribute("list", "modelSuggestions");

    wrapper.append(label, input);

    if (field.help) {
      const help = document.createElement("small");
      help.textContent = field.help;
      wrapper.appendChild(help);
    }

    elements.fields.appendChild(wrapper);
  }
}

function selectQuery(id) {
  const query = state.queries.find((item) => item.id === id) || state.queries[0];
  if (!query) return;

  state.current = query;
  elements.querySelect.value = query.id;
  elements.queryTitle.textContent = query.label;
  elements.queryDescription.textContent = query.description;

  if (query.needsReadAccessKey) {
    elements.credentialNotice.textContent = "Esta consulta usa a read access key configurada no servidor.";
    elements.credentialNotice.classList.remove("hidden");
  } else {
    elements.credentialNotice.classList.add("hidden");
  }

  renderFields(query);
  setMessage();
  elements.resultSection.classList.add("hidden");
}

function collectParams() {
  const formData = new FormData(elements.form);
  const params = {};
  for (const field of state.current.fields) {
    const value = formData.get(field.name);
    params[field.name] = typeof value === "string" ? value.trim() : value;
  }
  return params;
}

function xmlElementToObject(element) {
  const object = {};

  for (const attribute of element.attributes || []) {
    object[`@_${attribute.name}`] = attribute.value;
  }

  const childElements = [...element.children];
  if (!childElements.length) {
    const text = element.textContent.trim();
    if (Object.keys(object).length === 0) return text;
    if (text) object["#text"] = text;
    return object;
  }

  for (const child of childElements) {
    const value = xmlElementToObject(child);
    if (Object.prototype.hasOwnProperty.call(object, child.tagName)) {
      if (!Array.isArray(object[child.tagName])) object[child.tagName] = [object[child.tagName]];
      object[child.tagName].push(value);
    } else {
      object[child.tagName] = value;
    }
  }

  return object;
}

function parseXml(raw) {
  const documentXml = new DOMParser().parseFromString(raw, "application/xml");
  const parserError = documentXml.querySelector("parsererror");
  if (parserError) throw new Error("A resposta chegou, mas o XML não pôde ser interpretado.");
  return { [documentXml.documentElement.tagName]: xmlElementToObject(documentXml.documentElement) };
}

function collectObjectArrays(value, path = "root", found = []) {
  if (Array.isArray(value)) {
    if (value.length && value.every((item) => item && typeof item === "object" && !Array.isArray(item))) {
      found.push({ path, value });
    }
    value.forEach((item, index) => collectObjectArrays(item, `${path}[${index}]`, found));
    return found;
  }

  if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      collectObjectArrays(child, `${path}.${key}`, found);
    }
  }

  return found;
}

function findRows(parsed) {
  const arrays = collectObjectArrays(parsed);
  if (arrays.length) {
    arrays.sort((a, b) => b.value.length - a.value.length);
    return { path: arrays[0].path, rows: arrays[0].value };
  }

  const queue = [{ path: "root", value: parsed }];
  while (queue.length) {
    const current = queue.shift();
    if (!current?.value || typeof current.value !== "object" || Array.isArray(current.value)) continue;

    const entries = Object.entries(current.value);
    const primitiveCount = entries.filter(([, value]) => value === null || ["string", "number", "boolean"].includes(typeof value)).length;
    if (primitiveCount >= 2 && current.path !== "root") {
      return { path: current.path, rows: [current.value] };
    }

    for (const [key, child] of entries) {
      if (child && typeof child === "object") queue.push({ path: `${current.path}.${key}`, value: child });
    }
  }

  return { path: null, rows: [] };
}

function flattenRow(value, prefix = "", output = {}) {
  if (value === null || value === undefined) {
    if (prefix) output[prefix] = "";
    return output;
  }

  if (["string", "number", "boolean"].includes(typeof value)) {
    output[prefix || "value"] = value;
    return output;
  }

  if (Array.isArray(value)) {
    output[prefix || "value"] = value
      .map((item) => (typeof item === "object" ? JSON.stringify(item) : String(item)))
      .join(", ");
    return output;
  }

  for (const [key, child] of Object.entries(value)) {
    const next = prefix ? `${prefix}.${key}` : key;
    if (child && typeof child === "object" && !Array.isArray(child)) {
      flattenRow(child, next, output);
    } else if (Array.isArray(child)) {
      output[next] = child
        .map((item) => (typeof item === "object" ? JSON.stringify(item) : String(item)))
        .join(", ");
    } else {
      output[next] = child ?? "";
    }
  }

  return output;
}

function tabularize(parsed) {
  const { path, rows } = findRows(parsed);
  const flatRows = rows.map((row) => flattenRow(row));

  const allColumns = [];
  const seen = new Set();
  for (const row of flatRows) {
    for (const key of Object.keys(row)) {
      if (!seen.has(key)) {
        seen.add(key);
        allColumns.push(key);
      }
    }
  }

  // Filter to essential columns if the current query defines them
  let columns = allColumns;
  const essential = state.current?.essentialColumns;
  if (essential && essential.length) {
    const essentialLower = essential.map((c) => c.toLowerCase());
    const filtered = allColumns.filter((col) => essentialLower.includes(col.toLowerCase()));
    if (filtered.length) columns = filtered;
  }

  return { path, columns, rows: flatRows, allColumns };
}

function renderTable(table) {
  elements.resultTable.innerHTML = "";
  const { columns = [], rows = [] } = table || {};

  elements.tableMeta.textContent = rows.length
    ? `${rows.length} registro(s)`
    : "Nenhum resultado encontrado.";

  if (!rows.length || !columns.length) return;

  const thead = document.createElement("thead");
  const headerRow = document.createElement("tr");
  for (const column of columns) {
    const th = document.createElement("th");
    th.className = "sortable";
    const label = column;
    if (state.sortColumn === column) {
      th.textContent = label + (state.sortAsc ? " ▲" : " ▼");
      th.classList.add("sorted");
    } else {
      th.textContent = label;
    }
    th.addEventListener("click", () => {
      if (state.sortColumn === column) {
        state.sortAsc = !state.sortAsc;
      } else {
        state.sortColumn = column;
        state.sortAsc = true;
      }
      sortAndRender();
    });
    headerRow.appendChild(th);
  }
  thead.appendChild(headerRow);

  const tbody = document.createElement("tbody");
  for (const row of rows) {
    const tr = document.createElement("tr");
    for (const column of columns) {
      const td = document.createElement("td");
      const value = row[column];
      td.textContent = value === undefined || value === null ? "" : String(value);
      tr.appendChild(td);
    }
    tbody.appendChild(tr);
  }

  elements.resultTable.append(thead, tbody);
}

function getFilteredRows() {
  if (!state.tableData) return [];
  let rows = state.tableData.rows;

  for (const [column, filterValue] of Object.entries(state.activeFilters)) {
    if (!filterValue) continue;
    rows = rows.filter((row) => {
      const val = String(row[column] ?? "").toLowerCase();
      return val === filterValue.toLowerCase();
    });
  }

  return rows;
}

function sortAndRender() {
  if (!state.tableData) return;

  let rows = getFilteredRows();
  const col = state.sortColumn;
  const asc = state.sortAsc;

  if (col) {
    rows = [...rows].sort((a, b) => {
      let va = a[col] ?? "";
      let vb = b[col] ?? "";
      const na = parseFloat(va);
      const nb = parseFloat(vb);
      if (!isNaN(na) && !isNaN(nb)) {
        return asc ? na - nb : nb - na;
      }
      va = String(va).toLowerCase();
      vb = String(vb).toLowerCase();
      if (va < vb) return asc ? -1 : 1;
      if (va > vb) return asc ? 1 : -1;
      return 0;
    });
  }

  renderTable({ ...state.tableData, rows });
}

function buildFilters() {
  elements.tableFilters.innerHTML = "";
  if (!state.tableData || !state.tableData.rows.length) return;

  const columns = state.tableData.columns;
  const rows = state.tableData.rows;

  // Rentable filter: show when RentalDry or RentalWet columns exist
  const hasRentalDry = columns.some((c) => c.toLowerCase() === "rentaldry");
  const hasRentalWet = columns.some((c) => c.toLowerCase() === "rentalwet");

  if (hasRentalDry || hasRentalWet) {
    const label = document.createElement("label");
    label.className = "filter-toggle";
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.addEventListener("change", () => {
      if (checkbox.checked) {
        // Custom filter for rentable
        state.tableData._rentableOnly = true;
      } else {
        state.tableData._rentableOnly = false;
      }
      applyAllFilters();
    });
    label.append(checkbox, " Apenas alugáveis");
    elements.tableFilters.appendChild(label);
  }

  // Dropdown filters for columns with few unique values (like Type, Commodity)
  const filterableCols = ["Type", "Commodity", "UnitType"];
  for (const colName of filterableCols) {
    const matchedCol = columns.find((c) => c.toLowerCase() === colName.toLowerCase());
    if (!matchedCol) continue;

    const uniqueValues = [...new Set(rows.map((r) => String(r[matchedCol] ?? "")).filter(Boolean))].sort();
    if (uniqueValues.length < 2 || uniqueValues.length > 50) continue;

    const wrapper = document.createElement("div");
    wrapper.className = "filter-dropdown";

    const selectLabel = document.createElement("label");
    selectLabel.textContent = matchedCol + ":";
    selectLabel.className = "filter-label";

    const select = document.createElement("select");
    select.className = "filter-select";

    const allOption = document.createElement("option");
    allOption.value = "";
    allOption.textContent = "Todos";
    select.appendChild(allOption);

    for (const val of uniqueValues) {
      const opt = document.createElement("option");
      opt.value = val;
      opt.textContent = val;
      select.appendChild(opt);
    }

    select.addEventListener("change", () => {
      state.activeFilters[matchedCol] = select.value;
      applyAllFilters();
    });

    wrapper.append(selectLabel, select);
    elements.tableFilters.appendChild(wrapper);
  }
}

function applyAllFilters() {
  if (!state.tableData) return;

  let rows = state.tableData.rows;

  // Apply dropdown filters
  for (const [column, filterValue] of Object.entries(state.activeFilters)) {
    if (!filterValue) continue;
    rows = rows.filter((row) => {
      const val = String(row[column] ?? "").toLowerCase();
      return val === filterValue.toLowerCase();
    });
  }

  // Apply rentable filter
  if (state.tableData._rentableOnly) {
    const cols = state.tableData.columns;
    const dryCol = cols.find((c) => c.toLowerCase() === "rentaldry");
    const wetCol = cols.find((c) => c.toLowerCase() === "rentalwet");

    rows = rows.filter((row) => {
      const dry = dryCol ? parseFloat(row[dryCol]) || 0 : 0;
      const wet = wetCol ? parseFloat(row[wetCol]) || 0 : 0;
      return dry > 0 || wet > 0;
    });
  }

  // Apply sorting
  const col = state.sortColumn;
  const asc = state.sortAsc;
  if (col) {
    rows = [...rows].sort((a, b) => {
      let va = a[col] ?? "";
      let vb = b[col] ?? "";
      const na = parseFloat(va);
      const nb = parseFloat(vb);
      if (!isNaN(na) && !isNaN(nb)) return asc ? na - nb : nb - na;
      va = String(va).toLowerCase();
      vb = String(vb).toLowerCase();
      if (va < vb) return asc ? -1 : 1;
      if (va > vb) return asc ? 1 : -1;
      return 0;
    });
  }

  renderTable({ ...state.tableData, rows });

  elements.tableMeta.textContent = `${rows.length} de ${state.tableData.rows.length} registro(s)`;
}

async function loadModels() {
  try {
    const response = await fetch("/api/models");
    const data = await response.json();
    state.models = data.models || [];

    const datalist = document.createElement("datalist");
    datalist.id = "modelSuggestions";
    for (const model of state.models) {
      const option = document.createElement("option");
      option.value = model;
      datalist.appendChild(option);
    }
    document.body.appendChild(datalist);
  } catch (e) {
    console.warn("Could not load aircraft models for autocomplete:", e);
  }
}

async function runQuery(event) {
  event.preventDefault();
  if (!state.current) return;

  setMessage();
  elements.runButton.disabled = true;
  elements.runButton.textContent = "Consultando…";

  try {
    const response = await fetch("/api/query", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ queryId: state.current.id, params: collectParams() }),
    });

    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Falha na consulta.");

    const parsed = parseXml(data.raw || "");

    state.sortColumn = null;
    state.sortAsc = true;
    state.activeFilters = {};
    state.tableData = null;

    const table = tabularize(parsed);
    state.tableData = table;

    renderTable(table);
    buildFilters();

    elements.resultSection.classList.remove("hidden");
  } catch (error) {
    elements.resultSection.classList.add("hidden");
    setMessage(error.message, "error");
  } finally {
    elements.runButton.disabled = false;
    elements.runButton.textContent = "Pesquisar";
  }
}

async function bootstrap() {
  elements.querySelect.addEventListener("change", (event) => selectQuery(event.target.value));
  elements.form.addEventListener("submit", runQuery);

  const [queriesResponse, healthResponse] = await Promise.all([fetch("/api/queries"), fetch("/api/health")]);
  const queriesData = await queriesResponse.json();
  const health = await healthResponse.json();

  state.queries = queriesData.queries || [];
  renderQueryOptions();
  selectQuery(state.queries[0]?.id);

  // Load aircraft models for autocomplete (non-blocking)
  loadModels();

  if (health.userKeyConfigured) {
    elements.statusBadge.textContent = health.readAccessKeyConfigured ? "Chaves configuradas" : "User key configurada";
    elements.statusBadge.classList.add(health.readAccessKeyConfigured ? "ok" : "warn");
  } else {
    elements.statusBadge.textContent = "Configure o .env";
    elements.statusBadge.classList.add("warn");
  }
}

bootstrap().catch((error) => {
  elements.statusBadge.textContent = "Erro de inicialização";
  elements.statusBadge.classList.add("warn");
  setMessage(error.message, "error");
});
