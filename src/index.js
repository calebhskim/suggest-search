const axios = require('axios');
const get = require('lodash/get');
const DOMPurify = require('dompurify');
// For local development
// const l = require('./links.js');
// const n = require('./nodes.js');

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

const drawGraph = (links, nodes) => {
  const width = window.innerWidth || 420;
  const height = window.innerHeight || 420;
  const scale = d3.scaleOrdinal(d3.schemeCategory10);

  const dragstarted = d => {
    if (!d3.event.active) simulation.alphaTarget(0.3).restart();
    d.fx = d.x;
    d.fy = d.y;
  }

  const dragged = d => {
    d.fx = d3.event.x;
    d.fy = d3.event.y;
  }

  const dragended = d => {
    if (!d3.event.active) simulation.alphaTarget(0);
    d.fx = null;
    d.fy = null;
  }

  const drag = (simulation) => {

    const dragstarted = event => {
      if (!event.active) simulation.alphaTarget(0.3).restart();
      event.subject.fx = event.subject.x;
      event.subject.fy = event.subject.y;
    }
    
    const dragged = event => {
      event.subject.fx = event.x;
      event.subject.fy = event.y;
    }
    
    const dragended = event => {
      if (!event.active) simulation.alphaTarget(0);
      event.subject.fx = null;
      event.subject.fy = null;
    }
    
    return d3.drag()
      .on('start', dragstarted)
      .on('drag', dragged)
      .on('end', dragended);
  }

  const color = d => scale(d.group);

  const svg = d3.select('#graph-canvas')
      .attr('viewBox', [0, 0, width, height]);

  const simulation = d3.forceSimulation(nodes)
      .force('link', d3.forceLink(links)
          .id(d => d.id)
          .strength(link => link.rank / 30))
      .force('charge', d3.forceManyBody().strength(-100))
      .force('center', d3.forceCenter(width / 2, height / 2));

  const linkElements = svg.append('g')
      .attr('stroke', '#999')
      .attr('stroke-opacity', 0.6)
      .selectAll('line')
      .data(links)
      .join('line')
      .attr('stroke-width', d => Math.sqrt(d.rank));

  const textElements = svg.append('g')
    .selectAll('text')
    .data(nodes)
    .enter().append('text')
      .text(node => node.id)
      .attr('font-size', 15)
      .attr('dx', 15)
      .attr('dy', 4)
      .attr('class', 'node-label');

  const nodeElements = svg.append('g')
      .attr('stroke', '#fff')
      .attr('stroke-width', 1.5)
      .selectAll('circle')
      .data(nodes)
      .join('circle')
      .attr('r', 7)
      .attr('fill', color)
      .call(drag(simulation));

  const ticked = () => {
    linkElements
        .attr('x1', d => d.source.x)
        .attr('y1', d => d.source.y)
        .attr('x2', d => d.target.x)
        .attr('y2', d => d.target.y);
    nodeElements
      .attr('cx', d => d.x)
      .attr('cy', d => d.y);
    textElements
      .attr('x', node => node.x)
      .attr('y', node => node.y);
  }

  simulation
    .nodes(nodes)
    .on('tick', ticked);
};

const getSuggestions = async query => {
  const res = await axios.get(`https://ego-search.azurewebsites.net/?q=${query}`);

  // For local development
  // const res = await axios.get(`http://localhost:8080/?q=${query}`); // For local development

  if (res && res.data) {
    return res.data;
  }

  throw new Error('Error fetching suggestions');
};

/*
  Parse term out of 'suggestion'. Filter out bad results:
  - suggestion only contains one 'vs'
  - suggestion does not contain root search term
  ? suggestion does not contain any previously accepted terms from this depth
  Add new terms to queue.
*/ 
const process = (suggestion, seen, queue, comparator, rank, matrix, level, group) => {
  const terms = suggestion.split(comparator);

  // Suggestion should only contain one 'vs'
  if (terms.length === 2) {
    const source = terms[0].trim();
    const target = terms[1].trim();

    if (target && !(target in seen)) {
      seen[target] = true;
      queue.push(target);
      matrix.push({ source, target, rank, level, group, });
    }
  }
};

const generateNodes = matrix => {
  if (!matrix) {
    matrix = [];
  }

  const nodes = [];
  const seen = {};

  matrix.map(obj => {
    if (!(obj.source in seen)) {
      seen[obj.source] = true;
      nodes.push({
        id: obj.source,
        level: obj.level,
        group: obj.group,
      }); 
    }

    if (!(obj.target in seen)) {
      seen[obj.target] = true;
      nodes.push({
        id: obj.target,
        level: obj.level,
        group: obj.group,
      }); 
    }
  });

  return nodes;
};

const generateMatrix = async (term, comparator = 'vs', depth = 2) => {
  let matrix = [];
  
  const queue = [term, null];
  let level = 1;
  let group = 1;

  while (depth > 0) {
    while (queue.length > 0 && queue[0] !== null) {
      const seen = {}; // Should not double count within this depth

      const query = `${queue.shift()} ${comparator}`; // ex: 'docker vs'
      const res = await getSuggestions(query);
      await sleep(250);
      const suggestions = get(res, 'toplevel.CompleteSuggestion', null);

      if (suggestions) {
        suggestions.forEach((s, idx) => {
          const suggestion = get(s, 'suggestion[0].$.data', null);
          process(suggestion, seen, queue, comparator, idx + 1, matrix, level, group);
        });

        group += 1;
      }
    }

    if (queue.length > 0 && queue[0] === null) queue.shift();
    queue.push(null);
    level += 1;
    depth--;
  }

  return matrix;
};

const knownComparators = ['vs', 'and', 'or'];

const generateGraph = async e => {
  e.preventDefault();
  const container = document.getElementById('container');
  const spinner = document.getElementById('loading-spinner');
  let query = document.getElementById('search-query').value;

  if (window.requestInProgress) {
    return false;
  }

  window.requestInProgress = true;

  // Rate limit
  if (window.rateCounter > 5) {
    const invalidQueryBox = document.getElementById('too-many-requests-alert-box');
    invalidQueryBox.classList.remove('hide');
    return false;
  }

  window.rateCounter += 1;

  // Validte query
  if (!query || query.split(' ').some(el => knownComparators.includes(el))) {
    const invalidQueryBox = document.getElementById('invalid-query-alert-box');
    invalidQueryBox.classList.remove('hide');
    return false;
  }

  try {
    // Clear SVG
    document.getElementById('graph-canvas').remove();

    // Show spinner
    spinner.classList.remove('hide');

    // Create new SVG element
    const svgElement = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svgElement.setAttribute('id', 'graph-canvas');

    container.appendChild(svgElement);

    query = DOMPurify.sanitize(query);
    query = encodeURIComponent(query);

    const links = await generateMatrix(query);
    const nodes = generateNodes(links);

    // For local development
    // drawGraph(l.default, n.default);

    // Hide spinner
    spinner.classList.add('hide');

    drawGraph(links, nodes);
  }
  catch (e) {
    console.log('¯\\_(ツ)_/¯:', e);

    const alertBox = document.getElementById('alert-box');
    alertBox.classList.remove('hide');
  }
  finally {
    if (!spinner.classList.contains('hide')) {
      spinner.classList.add('hide');
    }

  }

  return false;
};

module.exports = {
  generateGraph,
}
