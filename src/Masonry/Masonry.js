// @flow
import React, { Component } from 'react';
import ReactDOM from 'react-dom';
import MasonryComponentWrapper from './MasonryComponentWrapper';
import ScrollFetch from '../ScrollFetch/ScrollFetch';
import styles from './Masonry.css';
import throttle from '../throttle';

const MAX_ITEMS_PER_INSERTION = 1;

type Props<T> = {|
  columnWidth: number,
  comp: () => void,
  flexible: boolean,
  gutterWidth: number,
  items: T[],
  minCols: number,
  loadItems: () => void,
  scrollContainer: HTMLElement,
|};

type GridItemType<T> = {
  component: {},
  key: number,
  itemData: T,
  column: number,
  width: number,
  height: number,
  left: number,
  top: number,
  bottom: number,
};

// Multiplied against container height.
// The amount of extra buffer space for populating visible items.
const VIRTUAL_BUFFER_FACTOR = 0.7;

function distance(a, b) {
  const x = a.x - b.x;
  const y = a.y - b.y;
  return Math.sqrt((x * x) + (y * y));
}

/**
 * Returns the index of the shortest column.
 */
function getShortestColumn(gridItems: Array<*>): number {
  let min = 0;
  for (let col = 0; col < gridItems.length; col += 1) {
    const colItems = gridItems[col];
    const lastItem = colItems[colItems.length - 1];
    const currMinColItems = gridItems[min];
    const currMin = currMinColItems[currMinColItems.length - 1];

    // If there is no last item in this column, set it as the min.
    if (!lastItem) {
      min = col;
      return min;
    }

    if (!currMin || lastItem.bottom < currMin.bottom) {
      min = col;
    }
  }
  return min;
}

class Masonry<T> extends Component {
  static defaultProps: {};

  constructor(props: Props<*>) {
    super(props);

    this.insertedItemsCount = 0;
    this.serverRefs = [];

    // Default to 0 gutterWidth when rendering flexibly.
    if (props.flexible && props.gutterWidth === null) {
      this.gutterWidth = 0;
    } else if (props.gutterWidth === null) {
      this.gutterWidth = 14;
    } else {
      this.gutterWidth = props.gutterWidth;
    }

    this.state = {
      fetchingFrom: false,
      height: 0,
      gridItems: [],
      serverItems: this.serverItems(props.items),
      minHeight: 0,
      mounted: false,
      viewportBottom: 0,
      viewportTop: 0,
    };
  }

  state: {
    fetchingFrom: bool | number,
    height: number,
    gridItems: Array<*>,
    serverItems: Array<*> | null,
    minHeight: number,
    mounted: boolean,
    viewportBottom: number,
    viewportTop: number,
  };

  /**
   * Adds hooks after the component mounts.
   */
  componentDidMount() {
    this.props.scrollContainer.addEventListener('scroll', this.updateVirtualBounds);
    window.addEventListener('resize', this.handleResize);

    // Determine #columns and itemWidth
    const { columnWidth, flexible } = this.props;
    const el = this.gridWrapper;
    if (el && el.parentNode instanceof HTMLElement) {
      const gridWidth = el.parentNode.clientWidth;
      this.columnCount = this.calculateColumns();
      this.itemWidth = flexible ? (gridWidth / this.columnCount) : (columnWidth + this.gutterWidth);
    }
    this.updateItems(this.props.items);
    this.updateVirtualBounds();
    setTimeout(() => {
      this.setState({
        mounted: true,
      });
    });
    this.gridWrapper.addEventListener('animationend', this.handleAnimationEnd);
  }

  componentWillReceiveProps({ items }: { items: Array<*> }) {
    if (this.state.fetchingFrom !== false && this.state.fetchingFrom !== items.length) {
      this.setState({
        fetchingFrom: false,
      });
    }

    if (items.length > this.props.items.length) {
      // Insert new items.
      this.updateItems(items);
    } else {
      // Shallow compare all items, if any change reflow the grid.
      for (let i = 0; i < items.length; i += 1) {
        if (items[i] !== this.props.items[i]) {
          this.setGridItems(items);
          break;
        }
      }
    }
  }

  /**
   * Sets the height of the grid after the component updates.
   * This allows stacking of items under the grid due to absolutely positioned elements.
   */
  componentDidUpdate() {
    clearTimeout(this.measureTimeout);
    this.measureTimeout = setTimeout(() => {
      this.measureContainer();
    });
  }

  /**
   * Remove listeners when unmounting.
   */
  componentWillUnmount() {
    if (this.insertAnimationFrame) {
      cancelAnimationFrame(this.insertAnimationFrame);
    }
    clearTimeout(this.resizeTimeout);
    clearTimeout(this.measureTimeout);
    this.props.scrollContainer.removeEventListener('scroll', this.updateVirtualBounds);
    window.removeEventListener('resize', this.handleResize);
    this.gridWrapper.removeEventListener('animationend', this.handleAnimationEnd);
  }

  /**
   * Returns the container height.
   */
  getContainerHeight() {
    const container = this.props.scrollContainer;
    return container.clientHeight || container.innerHeight;
  }


  getItemsRelatedTo(colIdx: number, iIdx: number, noItems: number = 5) {
    const { gridItems } = this.state;
    if (!gridItems[colIdx] || !gridItems[colIdx][iIdx]) {
      return [];
    }
    const itemA = gridItems[colIdx][iIdx];
    let allItems = [];
    gridItems.forEach((column, otherColIdx) => {
      column.forEach((itemB, otherItemIdx) => {
        if (itemB.top < itemA.top - 20 || (colIdx === otherColIdx && iIdx === otherItemIdx)) {
          return;
        }
        allItems.push({
          distance: this.calculateDistance(itemA, itemB),
          columnIdx: otherColIdx,
          itemIdx: otherItemIdx,
        });
      });
    });

    // group these by column, insert by the lowest idx in the column
    allItems = allItems.sort((a, b) => a.distance - b.distance);

    const columnToItemMapping = {};
    for (let i = 0; i < noItems; i += 1) {
      if (!allItems[i]) {
        break;
      }
      const { columnIdx, itemIdx } = allItems[i];
      if (!columnToItemMapping[columnIdx]) {
        columnToItemMapping[columnIdx] = {
          itemIdx,
          count: 1,
        };
      } else {
        columnToItemMapping[columnIdx].count += 1;
      }
    }

    return Object.keys(columnToItemMapping).map(column => ({
      columnIdx: column,
      ...columnToItemMapping[column],
    }));
  }

  /**
   * Returns the scroll position of the scroll container.
   */
  getScrollPos = () => {
    // Try accessing scrollY, as the grid will generally be scrolled by the window.
    const el = this.props.scrollContainer;
    return el.scrollY !== undefined ? el.scrollY : el.scrollTop;
  }

  /**
   * Sets all grid items in the grid.
   */
  setGridItems(items: Array<*>) {
    this.insertedItemsCount = 0;
    this.serverRefSizes = [];
    this.insertItems(items, null, null, true);
  }

  columnCount: number;
  gutterWidth: number;
  itemWidth: number;
  measureTimeout: ?number;

  /**
   * We need to remove the animation trigger for an element after it's finished animating.
   * This is necessary because we virtualize the grid and don't want animations replaying.
   */
  handleAnimationEnd = (e: Event) => {
    if (!(e.target instanceof HTMLElement)) {
      return;
    }
    const { classList } = e.target;
    if (classList.contains(styles.Masonry__Item__Animated)) {
      classList.remove(styles.Masonry__Item__Animated);
    }
  }

  calculateDistance(A:GridItemType<*>, B:GridItemType<*>) {
    const width = this.props.columnWidth;
    const gutterWidth = this.gutterWidth;
    if (A.column === B.column) {
      return A.top < B.top ?
        B.top - (A.bottom + gutterWidth) - 1 :
        A.top - (B.bottom + gutterWidth) - 1;
    }
    if (
      ((A.top <= B.top) && (A.bottom >= B.top)) ||
      ((A.top <= B.bottom) && (A.bottom >= B.bottom)) ||
      ((B.top <= A.top) && (B.bottom >= A.top))) {
      const columnWeight = 25;
      const columnDistance = (Math.abs(A.column - B.column) - 1) * columnWeight;
      return columnDistance + (Math.abs(A.top - B.top) / A.height);
    }
    if (A.top < B.top) {
      return A.left < B.left ?
        distance({ x: A.bottom, y: A.left + width }, { x: B.top, y: B.left }) :
        distance({ x: A.bottom, y: A.left }, { x: B.top, y: B.left + width });
    }
    return A.left < B.left ?
      distance({ x: A.top, y: A.left + width }, { x: B.bottom, y: B.left }) :
      distance({ x: A.top, y: A.left }, { x: B.bottom, y: B.left + width });
  }

  containerHeight: number;
  containerOffset: number;
  gridWrapper: HTMLElement;
  insertedItemsCount: number;
  insertAnimationFrame: ?number;
  itemKeyCounter: number;
  resizeTimeout: ?number;
  serverRefs: Array<HTMLElement>;
  serverRefSizes: Array<*>;

  updateItems(items: Array<*>) {
    if (!items) {
      return;
    }
    if (items.length !== this.insertedItemsCount) {
      this.insertItems(items.slice(this.insertedItemsCount));
    }
  }

  handleAddRelatedItems(itemInfo: GridItemType<T>) {
    return (items: Array<GridItemType<T>>) => {
      const itemIndex = this.state.gridItems[itemInfo.column].indexOf(itemInfo);
      const relatedItems = this.getItemsRelatedTo(itemInfo.column, itemIndex, items.length);
      relatedItems.forEach(({ columnIdx, itemIdx, count }) => {
        this.insertItems(items.splice(0, count), columnIdx, itemIdx);
      });
    };
  }

  serverItems(items: Array<*>) {
    const serverItems = items.map((itemData, key) => {
      const itemInfo = {};

      const component = (
        <this.props.comp
          data={itemData}
          addRelatedItems={this.handleAddRelatedItems(itemInfo)}
          itemIdx={key}
        />
      );

      return {
        component,
        key,
        top: 0,
        left: 0,
      };
    });
    return serverItems;
  }

  insertItems(newItems: Array<*>, colIdx?: (number | null) = null,
    itemIdx?: (number | null) = null, forceUpdate?: (boolean | null) = null) {
    const gridItems = forceUpdate ? [] : this.state.gridItems;
    const previousItemInColumn = colIdx !== null && itemIdx !== null &&
      gridItems[colIdx] && gridItems[colIdx][itemIdx - 1] ?
      gridItems[colIdx][itemIdx - 1] : null;

    if (!gridItems.length) {
      for (let i = 0; i < this.columnCount; i += 1) {
        gridItems.push([]);
      }
    }

    let items;
    if (forceUpdate) {
      items = newItems;
    } else if (this.serverRefs.length && this.insertedItemsCount < this.serverRefs.length) {
      items = newItems.slice(0, this.serverRefs.length - this.insertedItemsCount);
    } else if (newItems.length > MAX_ITEMS_PER_INSERTION) {
      items = newItems.slice(0, MAX_ITEMS_PER_INSERTION);
    } else {
      items = newItems;
    }

    this.itemKeyCounter = this.itemKeyCounter || 1;
    if (!this.serverRefSizes && this.serverRefs.length > 0) {
      this.serverRefSizes = this.serverRefs.map((ref) => {
        const serverRendered = ref;
        serverRendered.style.width = `${this.itemWidth}px`;
        return [serverRendered.clientWidth, serverRendered.clientHeight];
      });
    }

    // build out initial item info blobs for each component
    const pendingDomMeasurements = [];
    const itemInfos = items.map((itemData, insertedItemIdx) => {
      const actualIdx = insertedItemIdx + this.insertedItemsCount;
      const itemInfo = {};

      let key;
      if (colIdx != null && itemIdx != null) {
        const counterAsDecimal = (this.itemKeyCounter % 10000) / 1000;
        if (previousItemInColumn) {
          key = parseFloat(`${parseInt(previousItemInColumn.key, 10) + counterAsDecimal}`);
        } else {
          key = parseFloat(`${counterAsDecimal}`);
        }
      } else {
        key = this.itemKeyCounter;
      }
      this.itemKeyCounter += 1;

      const component = (
        <this.props.comp
          data={itemData}
          addRelatedItems={this.handleAddRelatedItems(itemInfo)}
          itemIdx={key}
        />
      );

      if (this.serverRefSizes && actualIdx < this.serverRefSizes.length) {
        const sizeInfo = this.serverRefSizes[actualIdx];
        itemInfo.width = sizeInfo[0];
        itemInfo.height = sizeInfo[1];
      } else {
        pendingDomMeasurements.push({
          component,
          itemInfo
        });
      }

      itemInfo.component = component;
      itemInfo.itemData = itemData;
      itemInfo.key = key;

      return itemInfo;
    });

    if (pendingDomMeasurements.length > 0) {
      // Append a temporary node to the dom to measure it.
      const measuringNode = document.createElement('div');

      if (document.body) {
        document.body.appendChild(measuringNode);
      }

      ReactDOM.unstable_renderSubtreeIntoContainer(
        this, <div> { pendingDomMeasurements.map(({ component }, idx) =>
          <div key={`el-${idx}`} style={{ width: `${this.itemWidth}px` }}>{ component }</div>
        )} </div>, measuringNode);

      const wrapperNodes = measuringNode.children[0].children;
      for (let i = 0; i < wrapperNodes.length; i += 1) {
        const { itemInfo } = pendingDomMeasurements[i];
        const el = wrapperNodes[i];
        itemInfo.width = el.clientWidth;
        itemInfo.height = el.clientHeight;
      }

      ReactDOM.unmountComponentAtNode(measuringNode);

      if (document.body) {
        document.body.removeChild(measuringNode);
      }
    }

    // insert the actual items into the grid
    items.forEach((itemData, insertedItemIdx) => {
      const itemInfo = itemInfos[insertedItemIdx];

      if (colIdx != null && itemIdx != null) {
        if (!gridItems[colIdx]) {
          return;
        }
        const left = colIdx * this.itemWidth;
        const top = previousItemInColumn ? previousItemInColumn.bottom : 0;

        // Construct a more specific render key for inserted items.
        // This allows us to properly order items after a reflow when sorting on the key.

        itemInfo.column = parseInt(colIdx, 10);
        itemInfo.left = left;
        itemInfo.top = top;
        itemInfo.bottom = top + itemInfo.height + this.gutterWidth;

        gridItems[colIdx].splice(itemIdx, 0, itemInfo);

        // Increase top values of other items
        if (itemIdx < gridItems[colIdx].length - 1) {
          const offset = gridItems[colIdx][itemIdx].bottom - gridItems[colIdx][itemIdx + 1].top;
          for (let i = itemIdx + 1; i < gridItems[colIdx].length; i += 1) {
            const gridItem = gridItems[colIdx][i];
            gridItem.top += offset;
            gridItem.bottom += offset;
          }
        }
      } else {
        const column = getShortestColumn(gridItems);

        const lastItemInColumn = gridItems[column][gridItems[column].length - 1];
        const top = (lastItemInColumn && lastItemInColumn.bottom) || 0;
        const left = column * this.itemWidth;

        itemInfo.column = column;
        itemInfo.appended = true;
        itemInfo.left = left;
        itemInfo.top = top;
        itemInfo.bottom = top + itemInfo.height + this.gutterWidth;
        itemInfo.key = itemInfo.key;

        gridItems[column].push(itemInfo);
      }
    });

    if (colIdx === null && itemIdx === null) {
      // update the number of items retrieved from the main feed
      this.insertedItemsCount += items.length;
    }

    // The grid height is the longest of all columns.
    let height = 0;
    let minHeight;
    for (let i = 0; i < gridItems.length; i += 1) {
      const column = gridItems[i];
      const lastItem = column[column.length - 1];
      if (lastItem && lastItem.bottom > height) {
        height = lastItem.bottom;
      }
      if (lastItem && (minHeight === undefined || minHeight > lastItem.bottom)) {
        minHeight = lastItem.bottom;
      }
    }

    this.setState({
      gridItems,
      height,
      minHeight: minHeight || this.state.minHeight,
      serverItems: null
    }, this.insertNextItems);
  }

  insertNextItems = () => {
    if (this.insertedItemsCount >= this.props.items.length) {
      return;
    }
    this.insertAnimationFrame = requestAnimationFrame(
      () => this.insertItems(this.props.items.slice(this.insertedItemsCount))
    );
  }

  /**
   * Delays resize handling in case the scroll container is still being resized.
   */
  handleResize = () => {
    if (this.resizeTimeout) {
      clearTimeout(this.resizeTimeout);
    }
    this.resizeTimeout = setTimeout(() => {
      const { columnWidth, flexible } = this.props;
      const el = this.gridWrapper;
      if (el && el.parentNode instanceof HTMLElement) {
        const gridWidth = el.parentNode.clientWidth;
        this.columnCount = this.calculateColumns();
        this.itemWidth = flexible ? (gridWidth / this.columnCount)
          : (columnWidth + this.gutterWidth);
        this.reflow();
      }
    }, 100);
  }

  updateVirtualBounds = throttle(() => {
    const scrollPos = this.props.scrollContainer.scrollY
      || this.props.scrollContainer.scrollTop
      || 0;
    const virtualBuffer = this.containerHeight * VIRTUAL_BUFFER_FACTOR;
    const offsetScrollPos = scrollPos - this.containerOffset;

    this.setState({
      viewportTop: offsetScrollPos - virtualBuffer,
      viewportBottom: offsetScrollPos + this.containerHeight + virtualBuffer,
    });
  })

  /**
   * Determines the number of columns to display.
   */
  calculateColumns() {
    if (!this.props.scrollContainer) {
      return 0;
    }

    const eachItemWidth = this.props.columnWidth + this.gutterWidth;
    const el = this.gridWrapper;
    if (el && el.parentNode instanceof HTMLElement) {
      const parentWidth = el.parentNode.clientWidth;

      let newColCount = Math.floor(parentWidth / eachItemWidth);

      if (newColCount < this.props.minCols) {
        newColCount = this.props.minCols;
      }
      return newColCount;
    }
    throw new Error('could not calculate columns');
  }

  measureContainer() {
    const { scrollContainer } = this.props;
    this.containerHeight = this.getContainerHeight();
    const el = this.gridWrapper;
    if (el instanceof HTMLElement) {
      if (typeof window !== 'undefined' && scrollContainer === window) {
        this.containerOffset = el.getBoundingClientRect().top
          + window.scrollY;
      } else {
        this.containerOffset = (el.getBoundingClientRect().top
          + scrollContainer.scrollTop)
          - scrollContainer.getBoundingClientRect().top;
      }
    }
  }

  /**
   * Reflows items if needed after a resize.
   * We need to reflow items if the number of columns we would display should change.
   */
  reflow() {
    this.measureContainer();
    const items = this.allItems().sort((a, b) => a.key - b.key).map(item => item.itemData);
    this.itemKeyCounter = 0;
    this.setGridItems(items);
  }

  /**
   * # of columns * total item width - 1 item margin
   */
  determineWidth() {
    return `${(this.state.gridItems.length * this.itemWidth) - this.gutterWidth}px`;
  }

  fetchMore = () => {
    if (this.props.loadItems) {
      const allItems = this.allItems();
      this.setState({
        fetchingFrom: allItems.length,
      });
      this.props.loadItems({
        from: allItems.length,
      });
    }
  }

  allItems() : Array<GridItemType<T>> {
    const allItems = [];
    if (!this.state.gridItems.length) {
      return [];
    }
    this.state.gridItems.map(column => column.map(item => allItems.push(item)));
    return allItems;
  }

  itemIsVisible(item: GridItemType<T>) {
    return !(item.bottom < this.state.viewportTop || item.top > this.state.viewportBottom);
  }

  renderHeight = () => {
    const { gridItems } = this.state;
    const colIdx = getShortestColumn(gridItems);
    const column = gridItems[colIdx];
    const lastItemInColumn = column && column[column.length - 1];
    return lastItemInColumn ? lastItemInColumn.bottom : null;
  }

  render() {
    const allItems = this.state.serverItems || this.allItems();
    const itemClassName = [
      this.state.serverItems ? 'static' : styles.Masonry__Item,
      this.state.mounted ? styles.Masonry__Item__Mounted : ''
    ].join(' ');
    return (
      <div
        className={styles.Masonry}
        ref={(ref) => { this.gridWrapper = ref; }}
        style={{ height: this.state.height, width: this.determineWidth() }}
      >
        <ScrollFetch
          container={this.props.scrollContainer}
          fetchMore={this.fetchMore}
          isFetching={this.state.fetchingFrom !== false
            || this.insertedItemsCount < this.props.items.length}
          renderHeight={this.renderHeight}
        />
        {allItems.map((item, idx) =>
          <MasonryComponentWrapper
            key={`wrapper-${item.key}`}
            isInViewport={this.itemIsVisible(item)}
            component={<div
              className={itemClassName}
              data-grid-item
              key={item.key}
              style={{
                top: 0,
                left: 0,
                transform: `translateX(${item.left}px) translateY(${item.top}px)`,
                ...(this.itemWidth ? { width: (this.itemWidth - this.gutterWidth) } : {}),
                ...(this.itemIsVisible(item) ? {} : { display: 'none', transition: 'none' })
              }}
              {...this.state.serverItems ? { ref: (ref) => {
                if (this.serverRefs.length <= idx) {
                  this.serverRefs.push(ref);
                }
              } } : {}}
            >
              <div
                className={item.appended || !this.state.mounted ?
                      null :
                      styles.Masonry__Item__Animated}
              >
                {item.component}
              </div>
            </div>}
          />,
        )}
      </div>
    );
  }
}

Masonry.propTypes = {
  /**
   * The preferred/target item width. If `flexible` is set, the item width will
   * grow to fill column space, and shrink to fit if below min columns.
   */
  columnWidth: React.PropTypes.number,

  /**
   * The component to render.
   */
  /* eslint react/no-unused-prop-types: 0 */
  comp: React.PropTypes.func.isRequired,

  /**
   * The preferred/target item width. Item width will grow to fill
   * column space, and shrink to fit if below min columns.
   */
  flexible: React.PropTypes.bool,

  /**
   * The amount of space between each item.
   */
  gutterWidth: React.PropTypes.number,

  /**
   * An array of all objects to display in the grid.
   */
  items: React.PropTypes.arrayOf(React.PropTypes.shape({})).isRequired,

  /**
   * A callback which the grid calls when we need to load more items as the user scrolls.
   * The callback should update the state of the items, and pass those in as props
   * to this component.
   */
  loadItems: React.PropTypes.func,

  /**
   * Minimum number of columns to display.
   */
  minCols: React.PropTypes.number,

  /**
   * The scroll container to use. Defaults to window.
   */
  scrollContainer: React.PropTypes.shape({
    addEventListener: React.PropTypes.func,
    removeEventListener: React.PropTypes.func,
    scrollTop: React.PropTypes.number,
    scrollY: React.PropTypes.number,
  }),
};

Masonry.defaultProps = {
  columnWidth: 236,
  gutterWidth: null,
  minCols: 3,
  scrollContainer: typeof window !== 'undefined' ? window : null,
  loadItems: () => {},
};

export default Masonry;
